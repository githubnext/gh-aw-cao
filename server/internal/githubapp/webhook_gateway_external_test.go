package githubapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestExternalCompilerDispatchRechecksDestinationWithoutGitHubSourceInference(t *testing.T) {
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-external-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	lock := append([]byte("# gh-aw-manifest: "), compact.Bytes()...)
	entries, err := gateway.ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", gateway.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile("../../../specs/fixtures/webhook-external-deliveries-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Sources    []gateway.ExternalSource `json:"sources"`
		Deliveries []struct {
			Expected map[string]any `json:"expected"`
		} `json:"deliveries"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		for _, scenario := range []string{"valid", "expired", "wrong-url", "changed-workflow", "public-destination"} {
			t.Run(entry.Declaration.Event+"/"+strings.Join(entry.Declaration.Types, ",")+"/"+scenario, func(t *testing.T) {
				trigger := entry.Declaration
				index := 0
				for fixtures.Sources[index].Event != trigger.Event {
					index++
				}
				source := fixtures.Sources[index]
				source.ExpiresAt = time.Now().Add(time.Hour)
				source.DestinationRepositoryIDs = []int64{42}
				if scenario == "expired" {
					source.ExpiresAt = time.Now().Add(-time.Second)
				}
				subscription := gatewayTestSubscription("repository_dispatch")
				subscription.Provider = map[string]string{"jira_issue": "jira", "linear_issue": "linear",
					"azure_devops_issue": "azure-devops", "webhook": "webhook"}[trigger.Event]
				subscription.Source = gateway.Source{ID: source.ID, Event: source.Event, External: &source}
				subscription.Destination.Fields = nil
				subscription.Destination.EventType, subscription.Compiler = trigger.Dispatch.EventType, &trigger
				revision := gateway.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("a", 40),
					MetadataPath: trigger.Dispatch.Workflow, Digest: gateway.MetadataDigest(lock), CompilerID: "gh-aw-manifest-v1"}
				projection := fixtures.Deliveries[index].Expected
				if source.Event == "webhook" {
					projection = map[string]any{"url": projection["url"], "type": trigger.Types}
					if len(trigger.Conditions) != 0 {
						projection["filters"] = fixtures.Deliveries[index].Expected["filters"]
					}
				}
				if scenario == "wrong-url" {
					projection = map[string]any{"url": "https://unapproved.example/resource/42", "type": projection["type"]}
				}
				payload, err := json.Marshal(map[string]any{"event_type": trigger.Dispatch.EventType, "client_payload": map[string]any{
					"schema_version": 2, "aw_context": map[string]any{"webhook": map[string]any{"event": source.Event,
						"deliveries": []any{map[string]any{"delivery_id": "delivery", "payload": projection}}}},
				}})
				if err != nil {
					t.Fatal(err)
				}
				posts := 0
				destination := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/repositories/42":
						visibility := "private"
						if scenario == "public-destination" {
							visibility = "public"
						}
						_, _ = fmt.Fprintf(w, `{"id":42,"full_name":"current/renamed","private":%v,"visibility":%q,
							"default_branch":"main","owner":{"id":99,"type":"Organization"}}`, visibility == "private", visibility)
					case "/repos/current/renamed/git/ref/heads/main":
						_, _ = fmt.Fprintf(w, `{"object":{"type":"commit","sha":%q}}`, revision.CommitSHA)
					case "/repos/current/renamed/contents/.github/workflows/test.lock.yml":
						if scenario == "changed-workflow" {
							_, _ = w.Write(append(lock, []byte("\n# changed")...))
						} else {
							_, _ = w.Write(lock)
						}
					case "/repos/current/renamed/dispatches":
						posts++
						w.WriteHeader(http.StatusNoContent)
					default:
						t.Errorf("unexpected destination request: %s", r.URL.Path)
						w.WriteHeader(http.StatusNotFound)
					}
				})
				adapter := WebhookGatewayDispatcher{Client: destination}
				result := adapter.DispatchCompiler(t.Context(), subscription, payload, revision)
				if scenario == "valid" {
					if result.StatusCode != http.StatusNoContent || posts != 1 {
						t.Fatal("external compiler dispatch failed", result.StatusCode, posts)
					}
				} else if result.TransportOutcome != "not-sent" || posts != 0 {
					t.Fatal("external preflight permitted stale or out-of-scope dispatch")
				}
			})
		}
	}
}
