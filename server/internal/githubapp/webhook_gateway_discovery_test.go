package githubapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func gatewayManifestLock(t *testing.T) []byte {
	t.Helper()
	fixture, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, fixture); err != nil {
		t.Fatal(err)
	}
	return []byte("# gh-aw-manifest: " + compact.String() + "\nname: test\n")
}

func TestPrivateDefaultBranchSubscriptionDiscovery(t *testing.T) {
	for _, scenario := range []string{"valid", "empty", "no-workflow-directory", "directory-disappeared-access", "public", "internal", "archived", "symlink", "bad-manifest", "moved", "oversized-file", "missing-permission", "duplicate", "too-many-files"} {
		t.Run(scenario, func(t *testing.T) {
			lock := gatewayManifestLock(t)
			headReads, rawReads, observations := 0, 0, 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("discovery attempted a write")
				}
				switch r.URL.Path {
				case "/repositories/42":
					visibility := "private"
					if scenario == "public" || scenario == "internal" {
						visibility = scenario
					}
					_, _ = fmt.Fprintf(w, `{"id":42,"full_name":"current/renamed","default_branch":"main",
						"owner":{"id":99,"type":"Organization"},"private":%v,"visibility":%q,"archived":%v}`,
						scenario != "public", visibility, scenario == "archived")
				case "/repos/current/renamed/git/ref/heads/main":
					headReads++
					if scenario == "directory-disappeared-access" && headReads == 2 {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					head := strings.Repeat("a", 40)
					if scenario == "moved" && headReads == 2 {
						head = strings.Repeat("b", 40)
					}
					_, _ = fmt.Fprintf(w, `{"object":{"type":"commit","sha":%q}}`, head)
				case "/repos/current/renamed/contents/.github/workflows":
					if r.URL.Query().Get("ref") != strings.Repeat("a", 40) {
						t.Error("listing did not use an immutable SHA")
					}
					switch scenario {
					case "no-workflow-directory", "directory-disappeared-access":
						w.WriteHeader(http.StatusNotFound)
						return
					case "empty":
						_, _ = w.Write([]byte("[]"))
						return
					case "missing-permission":
						w.WriteHeader(http.StatusForbidden)
						return
					case "symlink":
						_, _ = w.Write([]byte(`[{"path":".github/workflows/test.lock.yml","type":"symlink","size":1}]`))
						return
					case "oversized-file":
						_, _ = fmt.Fprintf(w, `[{"path":".github/workflows/test.lock.yml","type":"file","size":%d}]`, gateway.MaxWorkflowArtifactBytes+1)
						return
					case "duplicate":
						_, _ = w.Write([]byte(`[{"path":".github/workflows/test.lock.yml","type":"file","size":1},
							{"path":".github/workflows/test.lock.yml","type":"file","size":1}]`))
						return
					case "too-many-files":
						_ = json.NewEncoder(w).Encode(make([]map[string]any, 513))
						return
					}
					_, _ = fmt.Fprintf(w, `[{"path":".github/workflows/test.lock.yml","type":"file","size":%d}]`, len(lock))
				case "/repos/current/renamed/contents/.github/workflows/test.lock.yml":
					rawReads++
					if r.URL.Query().Get("ref") != strings.Repeat("a", 40) ||
						r.Header.Get("Accept") != "application/vnd.github.raw+json" {
						t.Error("lock was not fetched as raw bytes at the pinned SHA")
					}
					if scenario == "bad-manifest" {
						_, _ = w.Write([]byte("name: uncompiled\n"))
					} else {
						_, _ = w.Write(lock)
					}
				default:
					t.Errorf("unexpected API path %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			})
			result, err := client.DiscoverWebhookSubscriptions(t.Context(), gateway.DiscoveryRepository{
				Repository: "current/renamed", RepositoryID: 42, ReceivingInstallationID: 7, DispatchInstallationID: 8,
			}, func(githubquota.ResponseQuota) { observations++ })
			if scenario != "valid" && scenario != "empty" && scenario != "no-workflow-directory" {
				if err == nil {
					t.Fatal("incomplete or unauthorized inventory accepted")
				}
				return
			}
			if err != nil || result.RepositoryID != 42 || result.OwnerID != 99 || result.Visibility != "private" ||
				result.OwnerType != "Organization" || result.CommitSHA != strings.Repeat("a", 40) || headReads != 2 {
				t.Fatalf("inventory=%+v err=%v", result, err)
			}
			if scenario == "valid" && (len(result.Workflows) != 1 || len(result.Workflows[0].Triggers) != 3 ||
				result.Workflows[0].SHA256 != gateway.MetadataDigest(lock) || rawReads != 1 || observations != 6) {
				t.Fatalf("lost mapping, digest or quota observations: %+v observations=%d", result, observations)
			}
			if (scenario == "empty" || scenario == "no-workflow-directory") && len(result.Workflows) != 0 {
				t.Fatal("deleted workflow directory retained subscriptions")
			}
		})
	}
}

func TestDispatcherNeverSendsToPublicOrInternalRepository(t *testing.T) {
	for _, visibility := range []string{"public", "internal"} {
		t.Run(visibility, func(t *testing.T) {
			posts := 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/repositories/42" {
					_, _ = fmt.Fprintf(w, `{"id":42,"full_name":"current/renamed","owner":{"id":99},
						"private":%v,"visibility":%q}`, visibility == "internal", visibility)
					return
				}
				posts++
				w.WriteHeader(http.StatusNoContent)
			})
			s := gatewayTestSubscription("repository_dispatch")
			result := (WebhookGatewayDispatcher{Client: client}).Dispatch(t.Context(), s, gatewayTestEnvelope(s, json.RawMessage(`{}`)))
			if result.TransportOutcome != "not-sent" || posts != 0 {
				t.Fatalf("private-only gate bypassed: %+v posts=%d", result, posts)
			}
		})
	}
}

func TestCompilerDispatchRechecksCurrentHeadAndWholeArtifact(t *testing.T) {
	for _, scenario := range []string{"valid", "moved", "modified", "missing", "wrong-url-repository", "no-approved-revision"} {
		t.Run(scenario, func(t *testing.T) {
			lock := gatewayManifestLock(t)
			triggers, err := gateway.ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", gateway.DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			var trigger gateway.CompilerTrigger
			for _, entry := range triggers {
				if entry.Declaration.Event == "dependabot_alert" {
					trigger = entry.Declaration
				}
			}
			s := gatewayTestSubscription("repository_dispatch")
			s.Source.ID, s.Source.Event = gateway.CompilerSourceID, trigger.Event
			s.Destination.Fields = nil
			s.Source.RequiredPermissions = map[string]string{"contents": "read", "vulnerability_alerts": "read"}
			s.Destination.EventType, s.Compiler = trigger.Dispatch.EventType, &trigger
			revision := gateway.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("a", 40),
				MetadataPath: trigger.Dispatch.Workflow, Digest: gateway.MetadataDigest(lock), CompilerID: "gh-aw-manifest-v1"}
			projectionRepository := "current/renamed"
			if scenario == "wrong-url-repository" {
				projectionRepository = "other/repository"
			}
			payload, err := json.Marshal(map[string]any{
				"event_type": s.Destination.EventType,
				"client_payload": map[string]any{
					"schema_version": 2, "aw_context": map[string]any{"webhook": map[string]any{
						"event": trigger.Event, "deliveries": []any{map[string]any{
							"delivery_id": "delivery", "payload": map[string]any{
								"url":     "https://api.github.com/repos/" + projectionRepository + "/dependabot/alerts/42",
								"type":    []string{"created"},
								"filters": map[string]any{"severity": []string{"critical"}},
							},
						}},
					}},
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			posts, reads := 0, 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/repositories/42":
					_, _ = w.Write([]byte(`{"id":42,"full_name":"current/renamed","private":true,"visibility":"private",
						"default_branch":"main","owner":{"id":99,"type":"Organization"}}`))
				case "/repos/current/renamed/git/ref/heads/main":
					head := revision.CommitSHA
					if scenario == "moved" {
						head = strings.Repeat("b", 40)
					}
					_, _ = fmt.Fprintf(w, `{"object":{"type":"commit","sha":%q}}`, head)
				case "/repos/current/renamed/contents/.github/workflows/test.lock.yml":
					reads++
					switch scenario {
					case "missing":
						w.WriteHeader(http.StatusNotFound)
					case "modified":
						_, _ = w.Write(append(lock, []byte("# modified steps\n")...))
					default:
						_, _ = w.Write(lock)
					}
				case "/repos/current/renamed/dispatches":
					posts++
					if r.Method != http.MethodPost {
						t.Error("invalid dispatch method")
					}
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			})
			if scenario == "no-approved-revision" {
				revision = gateway.Revision{}
			}
			result := (WebhookGatewayDispatcher{Client: client}).DispatchCompiler(t.Context(), s, payload, revision)
			if scenario == "valid" {
				if result.StatusCode != http.StatusNoContent || posts != 1 || reads != 1 {
					t.Fatalf("valid compiler dispatch failed: %+v posts=%d reads=%d", result, posts, reads)
				}
			} else if result.TransportOutcome != "not-sent" || posts != 0 {
				t.Fatalf("stale compiler artifact dispatched: %+v posts=%d", result, posts)
			}
		})
	}
}
