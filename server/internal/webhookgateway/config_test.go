package webhookgateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func policyFixture(t *testing.T) (string, GatewayPolicy) {
	t.Helper()
	directory := t.TempDir()
	actionPath := "/action"
	subscription := Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "issue-change",
		TenantID: "org-22", AppID: 2,
		Source: Source{ID: "github", Event: "issues", InstallationID: 1, RepositoryID: 11, OrganizationID: 22,
			RequiredPermissions: map[string]string{"issues": "read"}},
		Destination: Destination{Kind: "workflow_dispatch", InstallationID: 2, RepositoryID: 12,
			Workflow: "work.yml", Ref: "main", Fields: []PayloadField{{Name: "action", Path: &actionPath, Required: true}}},
		Delivery: DeliveryPolicy{TTLSeconds: 86400, LeaseSeconds: 60, MaxAttempts: 5, RetryDelaySeconds: 10},
	}
	data, err := json.Marshal(subscription)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "subscription.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256Text(data)
	policy := GatewayPolicy{
		Version: 1, Enabled: true, Revision: 1, ReceivingAppID: 1, DispatchAppID: 2, Namespace: "gateway-test", Workers: 1,
		Artifacts: []CompiledArtifact{{Path: "subscription.json", SHA256: digest, RepositoryID: 12,
			CommitSHA: strings.Repeat("a", 40), CompilerID: "trusted-compiler"}},
		Grants: []AdminGrant{{SubscriptionID: subscription.ID, Digest: digest, SourceInstallationID: 1,
			SourceRepositoryID: 11, SourceOrganizationID: 22, ReceivingInstallationID: 1,
			DestinationInstallationID: 2, DestinationRepositoryID: 12, DispatchKind: "workflow_dispatch",
			ExpiresAt: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)}},
	}
	path := filepath.Join(directory, "cao.json")
	writePolicyFixture(t, path, policy)
	return path, policy
}

func writePolicyFixture(t *testing.T, path string, policy GatewayPolicy) {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"version": 1, "control-plane": map[string]any{
			"scope":           map[string]any{"allowed-owners": []string{"approved"}, "allowed-repositories": []string{"approved/exact"}},
			"webhook-gateway": policy,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayPolicyExactApprovalAndReload(t *testing.T) {
	path, policy := policyFixture(t)
	loader := NewPolicyLoader(path)
	first, err := loader.Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Subscriptions) != 1 || !first.Revision.Enabled || first.Revision.Revision != 1 ||
		first.RepositoryAllowed("approved/anything") || !first.RepositoryAllowed("approved/exact") || first.RepositoryAllowed("other/exact") ||
		first.RepositoryAllowed("other/not-approved") || first.OwnerAllowed("unapproved") {
		t.Fatalf("incorrect reviewed scope: %+v", first.Revision)
	}
	policy.Enabled = false
	policy.Revision++
	writePolicyFixture(t, path, policy)
	second, err := loader.Load(t.Context())
	if err != nil || second.Revision.Enabled || first.Revision.Digest == second.Revision.Digest {
		t.Fatalf("revocation did not reload: %+v %v", second.Revision, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := loader.Load(t.Context()); err == nil {
		t.Fatal("missing policy reused cached authority")
	}
}

func TestGatewayPolicyScopeIsPartOfRevocationIdentity(t *testing.T) {
	path, _ := policyFixture(t)
	loader := NewPolicyLoader(path)
	before, err := loader.Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path) // #nosec G304 -- path belongs to this test's temporary directory.
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"approved"`, `"revoked-owner"`, 1))
	if err := os.WriteFile(path, data, 0600); err != nil { // #nosec G703 -- path belongs to this test's temporary directory.
		t.Fatal(err)
	}
	after, err := loader.Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision.Digest == before.Revision.Digest || after.OwnerAllowed("approved") {
		t.Fatal("root authority narrowing reused old approval identity")
	}
}

func TestGatewayPolicyDeploymentChangesRequireRestart(t *testing.T) {
	path, policy := policyFixture(t)
	loader := NewPolicyLoader(path)
	if _, err := loader.Load(t.Context()); err != nil {
		t.Fatal(err)
	}
	policy.Namespace = "different"
	policy.Revision++
	writePolicyFixture(t, path, policy)
	if _, err := loader.Load(t.Context()); err == nil {
		t.Fatal("running process silently changed its storage namespace")
	}
}

func TestGatewayPolicyRejectsUntrustedArtifacts(t *testing.T) {
	for _, name := range []string{"digest", "grant", "traversal", "apps", "version", "compiler"} {
		t.Run(name, func(t *testing.T) {
			path, policy := policyFixture(t)
			switch name {
			case "digest":
				policy.Artifacts[0].SHA256 = strings.Repeat("0", 64)
			case "grant":
				policy.Grants[0].Digest = strings.Repeat("0", 64)
			case "traversal":
				policy.Artifacts[0].Path = "../subscription.json"
			case "apps":
				policy.DispatchAppID = policy.ReceivingAppID
			case "version":
				policy.Version = 2
			case "compiler":
				policy.Artifacts[0].CompilerID = ""
			}
			writePolicyFixture(t, path, policy)
			if _, err := (PolicyLoader{Path: path}).Load(t.Context()); err == nil {
				t.Fatal("untrusted configuration accepted")
			}
		})
	}
}

func TestGatewayPolicyRejectsDuplicatesAndUnknownFields(t *testing.T) {
	for _, extra := range []string{`"version":1,`, `"secret":"must-not-be-accepted",`} {
		t.Run(extra, func(t *testing.T) {
			path, _ := policyFixture(t)
			data, err := os.ReadFile(path) // #nosec G304 -- path belongs to this test's temporary directory.
			if err != nil {
				t.Fatal(err)
			}
			data = []byte(strings.Replace(string(data), `"webhook-gateway":{`, `"webhook-gateway":{`+extra, 1))
			if err := os.WriteFile(path, data, 0600); err != nil { // #nosec G703 -- path belongs to this test's temporary directory.
				t.Fatal(err)
			}
			if _, err := (PolicyLoader{Path: path}).Load(t.Context()); err == nil {
				t.Fatal("ambiguous or unknown gateway configuration accepted")
			}
		})
	}
}
