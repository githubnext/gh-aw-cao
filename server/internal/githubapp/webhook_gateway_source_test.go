package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestCompilerMultiRepositoryDispatchRechecksSource(t *testing.T) {
	for _, scenario := range []string{"exact", "wildcard", "org-match", "org-user", "org-wrong-owner", "org-outside", "missing-receiver", "public-source", "internal-source", "archived-source", "revoked-source", "renamed-source", "wrong-url", "changed-workflow", "source-quota-unavailable", "workflow-quota-unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			entries, err := gateway.ParseWorkflowManifest(gatewayManifestLock(t), ".github/workflows/test.lock.yml", gateway.DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			trigger := entries[1].Declaration
			if trigger.Event != "dependabot_alert" {
				t.Fatal("unexpected test declaration")
			}
			trigger.Repos = []string{"bar/baz"}
			if scenario == "wildcard" {
				trigger.Repos = []string{"bar/*"}
			}
			if strings.HasPrefix(scenario, "org-") {
				trigger.Orgs = []string{"bar*"}
				if scenario == "org-outside" {
					trigger.Orgs = []string{"different"}
				}
			}
			manifest, err := json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": []gateway.CompilerTrigger{trigger}})
			if err != nil {
				t.Fatal(err)
			}
			lock := []byte("# gh-aw-manifest: " + string(manifest) + "\nname: test\n")
			subscription := gatewayTestSubscription("repository_dispatch")
			subscription.Source.ID, subscription.Source.Event = gateway.CompilerSourceID, trigger.Event
			subscription.Source.RepositoryID = 43
			if strings.HasPrefix(scenario, "org-") {
				subscription.Source.OrganizationID = 98
			}
			subscription.Source.RequiredPermissions = map[string]string{"contents": "read", "vulnerability_alerts": "read"}
			subscription.Destination.Fields = nil
			subscription.Destination.EventType, subscription.Compiler = trigger.Dispatch.EventType, &trigger
			revision := gateway.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("a", 40),
				MetadataPath: trigger.Dispatch.Workflow, Digest: gateway.MetadataDigest(lock), CompilerID: "gh-aw-manifest-v1"}
			projectedRepo := "bar/baz"
			if scenario == "wrong-url" {
				projectedRepo = "bar/different"
			}
			payload := json.RawMessage(fmt.Sprintf(`{"event_type":%q,"client_payload":{"schema_version":2,
				"aw_context":{"webhook":{"event":"dependabot_alert","deliveries":[
				{"delivery_id":"delivery","payload":{"url":"https://api.github.com/repos/%s/dependabot/alerts/42","type":["created"],"filters":{"severity":["critical"]}}}]}}}}`,
				subscription.Destination.EventType, projectedRepo))
			sourceReads, posts, workflowReads := 0, 0, 0
			destination := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/repositories/42":
					_, _ = w.Write([]byte(`{"id":42,"full_name":"current/renamed","private":true,"visibility":"private",
						"default_branch":"main","owner":{"id":99,"type":"Organization"}}`))
				case "/repos/current/renamed/git/ref/heads/main":
					_, _ = fmt.Fprintf(w, `{"object":{"type":"commit","sha":%q}}`, revision.CommitSHA)
				case "/repos/current/renamed/contents/.github/workflows/test.lock.yml":
					workflowReads++
					if scenario == "changed-workflow" {
						_, _ = w.Write(append(lock, []byte("# changed\n")...))
					} else {
						_, _ = w.Write(lock)
					}
				case "/repos/current/renamed/dispatches":
					posts++
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("dispatch App unexpectedly read a source repository: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			})
			receiving := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/repositories/43" {
					t.Errorf("receiving App attempted unintended request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				sourceReads++
				if scenario == "revoked-source" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				visibility, name := "private", "bar/baz"
				switch scenario {
				case "public-source":
					visibility = "public"
				case "internal-source":
					visibility = "internal"
				case "renamed-source":
					name = "bar/renamed"
				}
				ownerID, ownerType := 98, "Organization"
				if scenario == "org-user" {
					ownerType = "User"
				}
				if scenario == "org-wrong-owner" {
					ownerID++
				}
				_, _ = fmt.Fprintf(w, `{"id":43,"full_name":%q,"private":%v,"visibility":%q,
					"archived":%v,"owner":{"id":%d,"type":%q}}`,
					name, visibility != "public", visibility, scenario == "archived-source", ownerID, ownerType)
			})
			if scenario == "missing-receiver" {
				receiving = nil
			}
			adapter := WebhookGatewayDispatcher{Client: destination, Receiving: receiving,
				ObserveReceivingQuota: func(context.Context, int64, githubquota.ResponseQuota) error {
					if scenario == "source-quota-unavailable" {
						return errors.New("quota unavailable")
					}
					return nil
				},
				ObserveQuota: func(context.Context, int64, githubquota.ResponseQuota) error {
					if scenario == "workflow-quota-unavailable" && workflowReads > 0 {
						return errors.New("quota unavailable")
					}
					return nil
				}}
			result := adapter.DispatchCompiler(t.Context(), subscription, payload, revision)
			if scenario == "exact" || scenario == "wildcard" || scenario == "org-match" {
				if result.StatusCode != http.StatusNoContent || posts != 1 || sourceReads != 1 || workflowReads != 1 {
					t.Fatalf("cross-repository preflight failed: status=%d posts=%d sources=%d workflows=%d",
						result.StatusCode, posts, sourceReads, workflowReads)
				}
			} else if result.TransportOutcome != "not-sent" || posts != 0 {
				t.Fatal("unsafe cross-repository dispatch escaped preflight")
			}
		})
	}
}
