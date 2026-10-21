package webhookgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestDiscoveryFleetCapacityBoundaries(t *testing.T) {
	for _, count := range []int{64, 65, 1000, MaxDiscoveryRepositories, MaxDiscoveryRepositories + 1} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			p := GatewayPolicy{Discovery: &DiscoveryPolicy{ActivateSecurity: true}}
			records := make([]RepositoryInventory, count)
			for i := range count {
				id := int64(i + 1)
				p.Discovery.Repositories = append(p.Discovery.Repositories, DiscoveryRepository{
					Repository: fmt.Sprintf("approved/repo-%d", id), RepositoryID: id,
					ReceivingInstallationID: 1, DispatchInstallationID: 2,
				})
				records[i] = RepositoryInventory{RepositoryID: id}
			}
			wantValid := count <= MaxDiscoveryRepositories
			if err := ValidateDiscoveryPolicy(p); (err == nil) != wantValid {
				t.Fatalf("discovery count=%d error=%v", count, err)
			}
			control := QueueRevision{Revision: 1, Digest: MetadataDigest([]byte("fleet-capacity")), Enabled: true}
			if _, err := RegistryDigest(control, records); (err == nil) != wantValid {
				t.Fatalf("registry count=%d error=%v", count, err)
			}
		})
	}
}

func TestCentralCampaignActivatesFullFleetWithinExistingByteBudget(t *testing.T) {
	base, registry := discoveryFixture(t)
	base.AllowedOwners, base.AllowedRepos = []string{"approved"}, nil
	source, binding := registry.Records[0], base.Policy.Discovery.Repositories[0]
	trigger := source.Workflows[0].Triggers[1]
	trigger.Repos = []string{"approved/*"}
	source.Workflows[0].Triggers = []CompilerTrigger{trigger}
	registry.Records = []RepositoryInventory{source}
	for i := 1; i < MaxDiscoveryRepositories; i++ {
		nextBinding := binding
		nextBinding.RepositoryID += int64(i)
		nextBinding.Repository = fmt.Sprintf("approved/repo-%d", i)
		base.Policy.Discovery.Repositories = append(base.Policy.Discovery.Repositories, nextBinding)
		record := source
		record.RepositoryID, record.Workflows = nextBinding.RepositoryID, nil
		registry.Records = append(registry.Records, record)
	}

	refreshRegistryDigest(t, &registry)
	data, err := json.Marshal(registry)
	if err != nil || len(data) > 1<<20 {
		t.Fatal("centralized fleet exceeded the unchanged registry byte budget", err)
	}
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil || len(policy.Subscriptions) != MaxDiscoveredSubscriptions {
		t.Fatalf("fleet routes=%d want=%d error=%v", len(policy.Subscriptions), MaxDiscoveredSubscriptions, err)
	}
	last := policy.Subscriptions[len(policy.Subscriptions)-1]
	if last.Source.RepositoryID != binding.RepositoryID+int64(MaxDiscoveryRepositories-1) ||
		last.Destination.RepositoryID != binding.RepositoryID {
		t.Fatal("expanded fleet lost distinct source identity or central campaign binding")
	}
	oversized := append([]RepositoryInventory(nil), registry.Records...)
	oversized[0].Visibility = string(make([]byte, 1<<20))
	if _, err := RegistryDigest(base.Revision, oversized); !errors.Is(err, ErrInvalid) {
		t.Fatal("expanded repository count widened the registry byte ceiling", err)
	}
}

func TestPolicyLoaderAcceptsExpandedEnrollmentWithoutWideningWebhookArrays(t *testing.T) {
	path, policy := policyFixture(t)
	policy.Discovery = &DiscoveryPolicy{ActivateSecurity: true}
	for i := range MaxDiscoveryRepositories {
		policy.Discovery.Repositories = append(policy.Discovery.Repositories, DiscoveryRepository{
			Repository: fmt.Sprintf("approved/repo-%d", i), RepositoryID: int64(i + 1),
			ReceivingInstallationID: 10, DispatchInstallationID: 20,
		})
	}
	data, err := json.Marshal(map[string]any{
		"version": 1, "control-plane": map[string]any{
			"scope":           map[string]any{"allowed-owners": []string{"approved"}},
			"webhook-gateway": policy,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := NewPolicyLoader(path).Load(t.Context())
	if err != nil || len(loaded.Policy.Discovery.Repositories) != MaxDiscoveryRepositories {
		t.Fatal("policy JSON loader rejected expanded enrollment", err)
	}
	if DefaultLimits().MaxArrayItems != 1024 {
		t.Fatal("control policy enrollment widened untrusted webhook array limits")
	}
}

func TestIngressIndexPartitionsImmutableRepositoryAndInstallation(t *testing.T) {
	h := &Ingress{}
	policy := PolicySnapshot{Revision: QueueRevision{Revision: 1, Digest: MetadataDigest([]byte("indexed")), Enabled: true}}
	for i := range 1000 {
		policy.Subscriptions = append(policy.Subscriptions, Subscription{ID: fmt.Sprintf("repo-%d", i),
			Source: Source{ID: "github", Event: "pull_request", InstallationID: 1, RepositoryID: int64(i + 1)}})
	}
	event := Event{SourceID: "github", Name: "pull_request", InstallationID: 1, RepositoryID: 1000}
	got := h.candidates(policy, event)
	if len(got) != 1 || got[0].Source.RepositoryID != event.RepositoryID {
		t.Fatal("ingress scanned subscriptions for unrelated repository identities")
	}
	event.InstallationID++
	if len(h.candidates(policy, event)) != 0 {
		t.Fatal("ingress index mixed installation authority")
	}
}
