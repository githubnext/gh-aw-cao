package webhookgatewayhost

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type registryFixture struct {
	snapshot gateway.RegistrySnapshot
	failOnce bool
}

func (s *registryFixture) BindRegistry(_ context.Context, control gateway.QueueRevision) (gateway.RegistrySnapshot, error) {
	if s.snapshot.Version == 0 || s.snapshot.Control != control {
		digest, err := gateway.RegistryDigest(control, nil)
		if err != nil {
			return gateway.RegistrySnapshot{}, err
		}
		s.snapshot = gateway.RegistrySnapshot{Version: s.snapshot.Version + 1, Control: control,
			Revision: gateway.QueueRevision{Revision: s.snapshot.Revision.Revision + 1, Digest: digest, Enabled: control.Enabled}}
	}
	return s.snapshot, nil
}

func (s *registryFixture) ReplaceRegistry(_ context.Context, control gateway.QueueRevision, version int64, records []gateway.RepositoryInventory) (gateway.RegistrySnapshot, error) {
	if s.failOnce {
		s.failOnce = false
		return gateway.RegistrySnapshot{}, gateway.ErrCapacity
	}
	if s.snapshot.Version != version || s.snapshot.Control != control {
		return gateway.RegistrySnapshot{}, gateway.ErrConflict
	}
	digest, err := gateway.RegistryDigest(control, records)
	if err != nil {
		return gateway.RegistrySnapshot{}, err
	}
	if digest != s.snapshot.Revision.Digest {
		s.snapshot.Revision.Revision++
		s.snapshot.Revision.Digest = digest
	}
	s.snapshot.Version++
	s.snapshot.Records = records
	return s.snapshot, nil
}

type discoveryFake struct {
	calls  int
	err    error
	hook   func()
	record *gateway.RepositoryInventory
}

func (d *discoveryFake) DiscoverWebhookSubscriptions(_ context.Context, binding gateway.DiscoveryRepository, _ func(githubquota.ResponseQuota)) (gateway.RepositoryInventory, error) {
	d.calls++
	if d.hook != nil {
		d.hook()
	}
	if d.record != nil {
		return *d.record, d.err
	}
	return gateway.RepositoryInventory{RepositoryID: binding.RepositoryID, OwnerID: 12, OwnerType: "Organization",
		Visibility: "private", CommitSHA: strings.Repeat("a", 40)}, d.err
}

func discoveryPolicyFixture() authorityPolicy {
	return authorityPolicy{gateway.PolicySnapshot{
		Policy: gateway.GatewayPolicy{ReceivingAppID: 1, DispatchAppID: 2, Discovery: &gateway.DiscoveryPolicy{
			IntervalSeconds: 30, ActivateSecurity: true, Repositories: []gateway.DiscoveryRepository{
				{Repository: "approved/private", RepositoryID: 11, ReceivingInstallationID: 10, DispatchInstallationID: 20},
			},
		}},
		Revision: gateway.QueueRevision{Revision: 1, Digest: strings.Repeat("a", 64), Enabled: true}, AllowedOwners: []string{"approved"},
	}}
}

func TestRoutineBackfillAndHintsInvalidateBeforeRescan(t *testing.T) {
	policy, registry, api := discoveryPolicyFixture(), &registryFixture{}, &discoveryFake{}
	worker := &DiscoveryWorker{Policies: policy, Registry: registry, GitHub: api}
	if err := worker.RunOnce(t.Context()); err != nil || api.calls != 1 || registry.snapshot.Records[0].Dirty {
		t.Fatalf("startup backfill: calls=%d err=%v", api.calls, err)
	}
	firstRevision := registry.snapshot.Revision
	if err := worker.RunOnce(t.Context()); err != nil || api.calls != 1 {
		t.Fatal("fresh inventory was unnecessarily rescanned", err)
	}
	registry.snapshot.Records[0].CheckedAt = time.Now().Add(-31 * time.Second)
	if err := worker.RunOnce(t.Context()); err != nil || api.calls != 2 || registry.snapshot.Revision != firstRevision {
		t.Fatal("unchanged routine backfill invalidated queued work", err)
	}
	hints := DiscoveryHints{Policies: policy, Registry: registry}
	event := gateway.Event{SourceID: gateway.CompilerSourceID, Name: "push", RepositoryID: 11, InstallationID: 10,
		Payload: []byte(`{"commits":[{"modified":[".github/workflows/test.lock.yml"]}]}`)}
	if handled, err := hints.Observe(t.Context(), event); err != nil || !handled || !registry.snapshot.Records[0].Dirty ||
		registry.snapshot.Revision == firstRevision {
		t.Fatal("signed hint did not durably invalidate before acknowledgment", err)
	}
	if err := worker.RunOnce(t.Context()); err != nil || api.calls != 3 || registry.snapshot.Records[0].Dirty {
		t.Fatal("dirty inventory was not rescanned", err)
	}
	event.RepositoryID = 999
	if _, err := hints.Observe(t.Context(), event); !errors.Is(err, gateway.ErrUnauthorized) {
		t.Fatal("hint widened repository enrollment", err)
	}
}

func TestScanFailureAndCapacityNeverKeepOldInventoryActive(t *testing.T) {
	for _, capacity := range []bool{false, true} {
		policy, registry, api := discoveryPolicyFixture(), &registryFixture{}, &discoveryFake{}
		worker := &DiscoveryWorker{Policies: policy, Registry: registry, GitHub: api}
		if err := worker.RunOnce(t.Context()); err != nil {
			t.Fatal(err)
		}
		registry.snapshot.Records[0].CheckedAt = time.Now().Add(-time.Minute)
		if capacity {
			registry.failOnce = true
		} else {
			api.err = gateway.ErrUnavailable
		}
		if err := worker.RunOnce(t.Context()); err == nil || !registry.snapshot.Records[0].Dirty ||
			len(registry.snapshot.Records[0].Workflows) != 0 {
			t.Fatal("failed discovery preserved active inventory", err)
		}
	}
}

func TestHintRacingBackfillFencesStalePublication(t *testing.T) {
	policy, registry, api := discoveryPolicyFixture(), &registryFixture{}, &discoveryFake{}
	worker := &DiscoveryWorker{Policies: policy, Registry: registry, GitHub: api}
	api.hook = func() {
		hints := DiscoveryHints{Policies: policy, Registry: registry}
		_, err := hints.Observe(t.Context(), gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository",
			RepositoryID: 11, InstallationID: 10})
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := worker.RunOnce(t.Context()); !errors.Is(err, gateway.ErrConflict) || !registry.snapshot.Records[0].Dirty {
		t.Fatal("scan from before invalidation restored stale authority", err)
	}
}

func TestHintOnAlreadyDirtyInventoryStillFencesScan(t *testing.T) {
	policy, registry, api := discoveryPolicyFixture(), &registryFixture{}, &discoveryFake{}
	hints := DiscoveryHints{Policies: policy, Registry: registry}
	event := gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository", RepositoryID: 11, InstallationID: 10}
	if _, err := hints.Observe(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	api.hook = func() {
		if _, err := hints.Observe(t.Context(), event); err != nil {
			t.Fatal(err)
		}
	}
	worker := &DiscoveryWorker{Policies: policy, Registry: registry, GitHub: api}
	if err := worker.RunOnce(t.Context()); !errors.Is(err, gateway.ErrConflict) || !registry.snapshot.Records[0].Dirty {
		t.Fatal("hint on already-dirty inventory failed to fence in-progress scan", err)
	}
}

func TestProjectAssignmentCannotRouteToAnotherRepository(t *testing.T) {
	for _, repository := range []int64{0, 21, 22} {
		policy, job, receiver, dispatcher := authorityFixture()
		job.Subscription.Source.ProjectIDs = []string{"PVT_project"}
		policy.Subscriptions = []gateway.Subscription{job.Subscription}
		policy.Policy.ProjectAssignments = []gateway.ProjectAssignment{{ProjectID: "PVT_project", OrganizationID: 12, RepositoryID: repository}}
		live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, Dispatch: dispatcher,
			Receiving: authorityProjectAPI{authorityAPI: receiver}}
		proof, err := live.Authorize(t.Context(), job)
		if err != nil || proof.SourceAccessible != (repository == 21) {
			t.Fatalf("assignment repository=%d accessible=%v err=%v", repository, proof.SourceAccessible, err)
		}
	}
}
