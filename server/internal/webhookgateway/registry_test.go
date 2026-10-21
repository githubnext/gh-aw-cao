package webhookgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func discoveryFixture(t *testing.T) (PolicySnapshot, RegistrySnapshot) {
	t.Helper()
	path, p := policyFixture(t)
	p.Artifacts, p.Grants = nil, nil
	p.Discovery = &DiscoveryPolicy{ActivateSecurity: true, Repositories: []DiscoveryRepository{
		{Repository: "approved/exact", RepositoryID: 11, ReceivingInstallationID: 10, DispatchInstallationID: 20},
	}}
	writePolicyFixture(t, path, p)
	base, err := NewPolicyLoader(path).Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	triggers, err := ParseWorkflowManifest(batchManifestFixture(t), ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	declarations := make([]CompilerTrigger, 0, len(triggers))
	for _, trigger := range triggers {
		declarations = append(declarations, trigger.Declaration)
	}
	now := time.Now().UTC()
	records := []RepositoryInventory{{RepositoryID: 11, OwnerID: 12, OwnerType: "Organization", Visibility: "private",
		CommitSHA: strings.Repeat("c", 40), CheckedAt: now, AttemptedAt: now,
		Workflows: []DiscoveredWorkflow{{Path: ".github/workflows/test.lock.yml", SHA256: MetadataDigest(batchManifestFixture(t)), Triggers: declarations}}}}
	registry := RegistrySnapshot{Version: 1, Control: base.Revision, Records: records}
	registry.Revision = QueueRevision{Revision: 2, Enabled: true}
	refreshRegistryDigest(t, &registry)
	return base, registry
}

func batchManifestFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	return []byte("# gh-aw-manifest: " + compact.String() + "\nname: batch-contract-fixture\n")
}

func refreshRegistryDigest(t *testing.T, registry *RegistrySnapshot) {
	t.Helper()
	digest, err := RegistryDigest(registry.Control, registry.Records)
	if err != nil {
		t.Fatal(err)
	}
	registry.Revision.Digest = digest
}

func TestRegistrySecurityEnrollmentAndFreshness(t *testing.T) {
	for _, scenario := range []string{"active", "dirty", "stale", "future", "disabled", "no-delegation", "public", "internal", "outside-scope", "forged-digest", "duplicate"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry := discoveryFixture(t)
			switch scenario {
			case "dirty":
				registry.Records[0].Dirty = true
			case "stale":
				registry.Records[0].CheckedAt = time.Now().Add(-10 * time.Minute)
			case "future":
				registry.Records[0].CheckedAt = time.Now().Add(time.Minute)
			case "disabled":
				base.Revision.Enabled, registry.Control.Enabled, registry.Revision.Enabled = false, false, false
			case "no-delegation":
				base.Policy.Discovery.ActivateSecurity = false
			case "public", "internal":
				registry.Records[0].Visibility = scenario
			case "outside-scope":
				base.AllowedOwners = []string{"different"}
			case "duplicate":
				registry.Records = append(registry.Records, registry.Records[0])
				if _, err := RegistryDigest(registry.Control, registry.Records); err == nil {
					t.Fatal("duplicate repository accepted")
				}
				return
			}
			refreshRegistryDigest(t, &registry)
			if scenario == "forged-digest" {
				registry.Revision.Digest = strings.Repeat("f", 64)
			}
			policy, err := RegistryPolicy(base, registry, time.Now())
			if scenario == "public" || scenario == "internal" || scenario == "outside-scope" || scenario == "forged-digest" {
				if err == nil {
					t.Fatal("invalid authority accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "active" {
				want = 2
			}
			if len(policy.Subscriptions) != want {
				t.Fatalf("subscriptions=%d want=%d", len(policy.Subscriptions), want)
			}
			for _, s := range policy.Subscriptions {
				if s.Source.RepositoryID != s.Destination.RepositoryID || s.Source.ID != CompilerSourceID ||
					s.Compiler == nil || SecurityEventPermission(s.Source.Event) == "" ||
					policy.Revisions[s.ID].Digest != registry.Records[0].Workflows[0].SHA256 {
					t.Fatal("unexpected activation or lost whole-artifact binding", s.ID)
				}
			}
		})
	}
}

func TestCompilerProjectionConformsWithoutRawSecurityPayload(t *testing.T) {
	base, registry := discoveryFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range policy.Subscriptions {
		t.Run(s.Source.Event, func(t *testing.T) {
			family := strings.TrimSuffix(strings.ReplaceAll(s.Source.Event, "_", "-"), "-alert")
			raw := []byte(fmt.Sprintf(`{"action":"created","installation":{"id":10},"organization":{"id":12},
				"repository":{"id":11,"private":true,"visibility":"private","full_name":"approved/exact","name":"not-forwarded"},
				"alert":{"number":42,"url":"https://api.github.com/repos/approved/exact/%s/alerts/42","state":"open","publicly_leaked":true,"secret":"NEVER-FORWARD",
				"title":"NEVER-FORWARD","body":"NEVER-FORWARD","assignees":[{"login":"octocat"}],
				"rule":{"id":"example","severity":"high"},"security_advisory":{"severity":"critical"}}}`, family))
			event, err := ParseEvent("delivery", s.Source.Event, raw, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			event.SourceID = CompilerSourceID
			matched, err := MatchSubscription(s, event, DefaultLimits())
			if err != nil || !matched {
				t.Fatalf("compiler predicate mismatch: %v %v", matched, err)
			}
			payload, err := buildGatewayDispatchPayload(s, event, policy.Revisions[s.ID], DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(payload), "NEVER-FORWARD") || strings.Contains(string(payload), "publicly_leaked") ||
				strings.Contains(string(payload), "assignees") || strings.Contains(string(payload), "not-forwarded") {
				t.Fatal("non-allowlisted payload was persisted")
			}
			if err := ValidateDispatchPayload(s, payload, DefaultLimits()); err != nil {
				t.Fatal(err)
			}
			tight := s
			contract := *s.Compiler
			tight.Compiler = &contract
			job, err := NewJob(time.Now(), "compiler-job", event, s, policy.Revisions[s.ID].Digest)
			if err != nil {
				t.Fatal(err)
			}
			job.Payload = payload
			batch, err := BuildDispatchBatch([]Job{job})
			if err != nil {
				t.Fatal(err)
			}
			var framed map[string]json.RawMessage
			if err := json.Unmarshal(batch, &framed); err != nil {
				t.Fatal(err)
			}
			contract.Dispatch.MaxRequestBytes = len(batch)
			contract.Dispatch.MaxPayloadBytes = len(framed["client_payload"])
			if err := ValidateBatchDispatchPayload(tight, batch, DefaultLimits()); err != nil {
				t.Fatal("exact framed batch byte ceilings rejected", err)
			}
			exact := job
			exact.Subscription = tight
			exact.Payload, err = buildGatewayDispatchPayload(tight, event, policy.Revisions[s.ID], DefaultLimits())
			if err != nil {
				t.Fatal("internal provenance incorrectly consumed compiler wire byte budget", err)
			}
			if _, err := BuildDispatchBatch([]Job{exact}); err != nil {
				t.Fatal("exact framed compiler budget failed production batch construction", err)
			}
			contract.Dispatch.MaxRequestBytes--
			if ValidateBatchDispatchPayload(tight, batch, DefaultLimits()) == nil {
				t.Fatal("batch request one-byte excess accepted")
			}
			contract.Dispatch.MaxRequestBytes++
			contract.Dispatch.MaxPayloadBytes--
			if ValidateBatchDispatchPayload(tight, batch, DefaultLimits()) == nil {
				t.Fatal("batch context one-byte excess accepted")
			}
			if revision, err := DispatchRevision([]Job{job}); err != nil || revision != policy.Revisions[s.ID] {
				t.Fatalf("lost runtime provenance: %+v %v", revision, err)
			}
			var envelope map[string]any
			if err := json.Unmarshal(payload, &envelope); err != nil {
				t.Fatal(err)
			}
			properties := envelope["client_payload"].(map[string]any)
			if len(properties) != 5 || properties["schema_version"] != float64(1) ||
				properties["event"] != s.Source.Event || properties["delivery_id"] != "delivery" {
				t.Fatal("compiler context contract changed")
			}
			properties["payload"].(map[string]any)["secret"] = "not-allowed"
			corrupt, _ := json.Marshal(envelope)
			if ValidateDispatchPayload(s, corrupt, DefaultLimits()) == nil {
				t.Fatal("extra nested property accepted")
			}
			bad := s
			trigger := *s.Compiler
			trigger.Dispatch.MaxPayloadBytes, trigger.Dispatch.MaxRequestBytes = 200, 200
			bad.Compiler = &trigger
			if ValidateBatchDispatchPayload(bad, batch, DefaultLimits()) == nil {
				t.Fatal("compiler byte ceiling ignored")
			}
		})
	}
}

func TestDiscoveryConfigurationStrictness(t *testing.T) {
	for _, data := range []string{
		`{"repositories":[]}`, `{"repositories":[],"activateSecurity":null}`,
		`{"repositories":[],"activateSecurity":"true"}`, `{"repositories":[],"activateSecurity":true,"unknown":1}`,
	} {
		var policy DiscoveryPolicy
		if json.Unmarshal([]byte(data), &policy) == nil {
			t.Fatal("invalid discovery policy accepted", data)
		}
	}
	base, _ := discoveryFixture(t)
	p := base.Policy
	p.ProjectAssignments = []ProjectAssignment{{ProjectID: "PVT_project", OrganizationID: 12, RepositoryID: 11}}
	if ValidateDiscoveryPolicy(p) != nil || !(PolicySnapshot{Policy: p}).ProjectAssigned("PVT_project", 12, 11) ||
		(PolicySnapshot{Policy: p}).ProjectAssigned("PVT_project", 12, 99) {
		t.Fatal("project assignment is not exact")
	}
	p.ProjectAssignments[0].RepositoryID = 99
	if !errors.Is(ValidateDiscoveryPolicy(p), ErrInvalid) {
		t.Fatal("unenrolled project repository accepted")
	}
}

func TestSignedDiscoveryHintShapes(t *testing.T) {
	for _, tc := range []struct {
		body string
		want bool
	}{
		{`{"commits":[{"modified":[".github/workflows/test.lock.yml"]}]}`, true},
		{`{"commits":[{"removed":[".github/workflows/test.lock.yml"]}]}`, true},
		{`{"commits":[{"added":[".github/workflows/test.lock.yml"]}]}`, true},
		{`{"forced":true,"commits":[]}`, true},
		{`{"size":2,"commits":[]}`, true},
		{`{}`, true},
		{`{"commits":[{"modified":[".github/workflows/sub/test.lock.yml","README.md"]}]}`, false},
		{`{"commits":[]}`, false},
	} {
		changed, err := DiscoveryUpdate(Event{Name: "push", Payload: json.RawMessage(tc.body)})
		if err != nil || changed != tc.want {
			t.Fatalf("%s: changed=%v want=%v err=%v", tc.body, changed, tc.want, err)
		}
	}
}
