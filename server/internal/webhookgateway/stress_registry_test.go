package webhookgateway_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/simulator"
	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
	"github.com/githubnext/gh-cao/server/internal/webhookgatewayhost"
)

// The registry is a synthetic GitHub inventory boundary, not a durability test.
// All discovery scheduling, parsing and policy intersection remain production code.
type stressRegistry struct {
	snapshot wg.RegistrySnapshot
}

func (s *stressRegistry) BindRegistry(_ context.Context, control wg.QueueRevision) (wg.RegistrySnapshot, error) {
	if s.snapshot.Version == 0 {
		digest, err := wg.RegistryDigest(control, nil)
		if err != nil {
			return wg.RegistrySnapshot{}, err
		}
		s.snapshot = wg.RegistrySnapshot{Version: 1, Control: control,
			Revision: wg.QueueRevision{Revision: 1, Digest: digest, Enabled: control.Enabled}}
	}
	if control != s.snapshot.Control {
		return wg.RegistrySnapshot{}, wg.ErrConflict
	}
	return s.snapshot, nil
}

func (s *stressRegistry) ReplaceRegistry(_ context.Context, control wg.QueueRevision, version int64, records []wg.RepositoryInventory) (wg.RegistrySnapshot, error) {
	if s.snapshot.Version != version || s.snapshot.Control != control {
		return wg.RegistrySnapshot{}, wg.ErrConflict
	}
	digest, err := wg.RegistryDigest(control, records)
	if err != nil {
		return wg.RegistrySnapshot{}, err
	}
	if digest != s.snapshot.Revision.Digest {
		s.snapshot.Revision.Revision++
		s.snapshot.Revision.Digest = digest
	}
	s.snapshot.Version++
	s.snapshot.Records = slices.Clone(records)
	return s.snapshot, nil
}

type stressPolicy struct {
	base     wg.PolicySnapshot
	registry *stressRegistry
	clock    *simulator.ManualClock
	version  int64
	at       time.Time
	cached   wg.PolicySnapshot
}

func (p *stressPolicy) Load(context.Context) (wg.PolicySnapshot, error) {
	if p.version != p.registry.snapshot.Version || p.at != p.clock.Now() {
		next, err := wg.RegistryPolicy(p.base, p.registry.snapshot, p.clock.Now())
		if err != nil {
			return wg.PolicySnapshot{}, err
		}
		p.cached, p.version, p.at = next, p.registry.snapshot.Version, p.clock.Now()
	}
	return p.cached, nil
}

type stressBase struct{ snapshot wg.PolicySnapshot }

func (p stressBase) Load(context.Context) (wg.PolicySnapshot, error) { return p.snapshot, nil }

type stressShard struct {
	policy    *stressPolicy
	discovery *webhookgatewayhost.DiscoveryWorker
	queue     wg.Queue
	ingress   *wg.Ingress
	worker    *wg.Worker
}

func stressManifest(t *testing.T) []byte {
	t.Helper()
	lock, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version  int                  `json:"version"`
		Triggers []wg.CompilerTrigger `json:"webhook_subscriptions"`
	}
	if err := json.Unmarshal(lock, &manifest); err != nil {
		t.Fatal(err)
	}
	trigger := manifest.Triggers[1]
	trigger.Event, trigger.NativeEvents, trigger.Types = "pull_request", []string{"pull_request"}, []string{"ready_for_review"}
	trigger.Repos = []string{"simulator/*"}
	trigger.Conditions = []wg.CompilerCondition{}
	data, err := json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": []wg.CompilerTrigger{trigger}})
	if err != nil {
		t.Fatal(err)
	}
	artifact := append([]byte("# gh-aw-manifest: "), data...)
	if _, err := wg.ParseWorkflowManifest(artifact, ".github/workflows/test.lock.yml", wg.DefaultLimits()); err != nil {
		t.Fatal("synthetic vulnerability-review campaign", err)
	}
	return artifact
}

func stressQueueOptions() wg.QueueOptions {
	budget := wg.RateBudget{Capacity: 1000, Period: time.Minute}
	return wg.QueueOptions{
		MaxRows: 200000, MaxBytes: 1 << 30, MaxTenantRows: 10000, MaxTenantBytes: 128 << 20,
		MaxSourceRows: 10000, MaxSourceBytes: 128 << 20, MaxDestinationRows: 200000, MaxDestinationBytes: 1 << 30,
		MaxPayloadBytes: 1 << 20, MaxBatch: 64, MaxConcurrency: 8, MaxAge: time.Hour,
		DedupWindow: time.Hour, TerminalRetention: time.Hour, LeaseDuration: time.Minute,
		Rates: wg.RateBudgets{Global: budget, App: budget, Tenant: budget, Destination: budget, Workflow: budget},
	}
}

func stressBasePolicy(repos []simulator.FleetRepository, shard, shards int) wg.PolicySnapshot {
	p := wg.PolicySnapshot{
		Revision:      wg.QueueRevision{Revision: 1, Digest: wg.MetadataDigest([]byte("synthetic-security-campaign-" + strconv.Itoa(shard))), Enabled: true},
		AllowedOwners: []string{"simulator"},
		Policy: wg.GatewayPolicy{Version: 1, Enabled: true, Revision: 1, Namespace: "stress-" + strconv.Itoa(shard),
			ReceivingAppID: 1, DispatchAppID: 2, Queue: stressQueueOptions(), Workers: 1,
			Discovery: &wg.DiscoveryPolicy{IntervalSeconds: 3600, ActivateNotifications: true}},
	}
	for _, repo := range repos {
		if int(repo.ID-1001)%shards == shard {
			p.Policy.Discovery.Repositories = append(p.Policy.Discovery.Repositories, wg.DiscoveryRepository{
				Repository: repo.Name, RepositoryID: repo.ID, ReceivingInstallationID: 1, DispatchInstallationID: 2,
			})
		}
	}
	return p
}

// Synthetic live facts are deliberately separated from production authority
// gates: this test does not claim to exercise GitHub App authentication.
func (s *stressShard) Authorize(ctx context.Context, job wg.Job) (wg.AuthorizationSnapshot, error) {
	p, err := s.policy.Load(ctx)
	if err != nil {
		return wg.AuthorizationSnapshot{}, err
	}
	now, source, destination := s.policy.clock.Now(), job.Subscription.Source, job.Subscription.Destination
	grant, found := p.Grants[job.Subscription.ID]
	if !found {
		return wg.AuthorizationSnapshot{}, errors.New("synthetic repository is not discovered")
	}
	return wg.AuthorizationSnapshot{
		Complete: true, JobID: job.ID, Fence: job.Fence, Attempt: job.Attempt + 1, CheckedAt: now, ExpiresAt: now.Add(20 * time.Second),
		CurrentRevision: p.Revisions[job.Subscription.ID], Grant: grant,
		SourceInstallationID: source.InstallationID, ReceivingInstallationID: source.InstallationID,
		SourceRepositoryID: source.RepositoryID, SourceOrganizationID: source.OrganizationID,
		DestinationInstallationID: destination.InstallationID, DestinationRepositoryID: destination.RepositoryID,
		SourceAccessible: true, DestinationAccessible: true, SourcePermissionsOK: true, DispatchPermissionsOK: true,
		SourceVisibility: "private", DestinationVisibility: "private",
	}, nil
}
