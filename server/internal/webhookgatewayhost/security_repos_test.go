package webhookgatewayhost

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestMultiRepositorySecurityAuthorityUsesSourceAndDestinationIndependently(t *testing.T) {
	for _, scenario := range []string{"exact", "wildcard", "renamed-outside-selector", "source-public", "destination-public", "source-revoked", "destination-artifact-changed"} {
		t.Run(scenario, func(t *testing.T) {
			policy, job, receiver, dispatcher := authorityFixture()
			fixture, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v2.json")
			if err != nil {
				t.Fatal(err)
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, fixture); err != nil {
				t.Fatal(err)
			}
			triggers, err := gateway.ParseWorkflowManifest(
				[]byte("# gh-aw-manifest: "+compact.String()+"\nname: fixture\n"), ".github/workflows/test.lock.yml", gateway.DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			var trigger gateway.CompilerTrigger
			for _, entry := range triggers {
				if entry.Declaration.Event == "dependabot_alert" {
					trigger = entry.Declaration
				}
			}
			trigger.Repos = []string{"approved/source"}
			if scenario == "wildcard" {
				trigger.Repos = []string{"approved/*"}
			}
			subscription := job.Subscription
			subscription.Source.ID, subscription.Source.Event = gateway.CompilerSourceID, trigger.Event
			subscription.Source.RequiredPermissions = map[string]string{"contents": "read", "vulnerability_alerts": "read"}
			subscription.Destination.Kind, subscription.Destination.EventType = "repository_dispatch", trigger.Dispatch.EventType
			subscription.Destination.Workflow, subscription.Destination.Ref = "", ""
			subscription.Compiler = &trigger
			job.Subscription, policy.Subscriptions = subscription, []gateway.Subscription{subscription}
			job.Event.SourceID, job.Event.Name = gateway.CompilerSourceID, trigger.Event
			revision := policy.Revisions[subscription.ID]
			revision.MetadataPath = trigger.Dispatch.Workflow
			policy.Revisions[subscription.ID] = revision
			grant := policy.Grants[subscription.ID]
			grant.DispatchKind = "repository_dispatch"
			policy.Grants[subscription.ID] = grant
			receiver.installation.Permissions = subscription.Source.RequiredPermissions
			dispatcher.installation.Permissions = map[string]string{"contents": "write"}
			artifact := compilerAuthorityAPI{authorityAPI: dispatcher, head: revision.CommitSHA, digest: revision.Digest,
				expectedRepository: subscription.Destination.RepositoryID, expectedInstallation: subscription.Destination.InstallationID}
			switch scenario {
			case "renamed-outside-selector":
				receiver.repository.FullName = "approved/renamed"
			case "source-public":
				receiver.repository.Private, receiver.repository.Visibility = false, "public"
			case "destination-public":
				artifact.repository.Private, artifact.repository.Visibility = false, "public"
			case "source-revoked":
				receiver.installation.Suspended = true
			case "destination-artifact-changed":
				artifact.digest = gateway.MetadataDigest([]byte("changed"))
			}
			live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, Receiving: receiver, Dispatch: artifact}
			proof, err := live.Authorize(t.Context(), job)
			if err != nil {
				t.Fatal(err)
			}
			decision, err := gateway.ValidateAuthorization(time.Now(), job, proof)
			want := scenario == "exact" || scenario == "wildcard"
			if err != nil || decision.Allowed != want {
				t.Fatalf("source/destination authority allowed=%v want=%v err=%v", decision.Allowed, want, err)
			}
		})
	}
}
