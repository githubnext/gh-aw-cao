package webhookgatewayhost

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"time"

	"github.com/githubnext/gh-cao/server/internal/clock"
	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/logger"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

var discoveryLog = logger.New("cao:webhook-gateway:discovery")

type RegistryLoader struct {
	Base  PolicyLoader
	Store gateway.RegistryStore
	Clock clock.Provider
}

func (l RegistryLoader) Load(ctx context.Context) (gateway.PolicySnapshot, error) {
	if l.Base == nil || l.Store == nil {
		return gateway.PolicySnapshot{}, gateway.ErrInvalid
	}
	base, err := l.Base.Load(ctx)
	if err != nil {
		return base, err
	}
	registry, err := l.Store.BindRegistry(ctx, base.Revision)
	if err != nil {
		return gateway.PolicySnapshot{}, err
	}
	if base.Policy.Discovery == nil {
		base.Revision = registry.Revision
		return base, nil
	}
	return gateway.RegistryPolicy(base, registry, clock.Now(l.Clock))
}

type DiscoveryAPI interface {
	DiscoverWebhookSubscriptions(context.Context, gateway.DiscoveryRepository, func(githubquota.ResponseQuota)) (gateway.RepositoryInventory, error)
}

type DiscoveryWorker struct {
	Policies PolicyLoader
	Registry gateway.RegistryStore
	GitHub   DiscoveryAPI
	Quota    QuotaService
	Clock    clock.Provider
	next     int
}

func (d *DiscoveryWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		if err := d.RunOnce(ctx); err != nil && ctx.Err() == nil {
			discoveryLog.Printf("subscription scan incomplete")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (d *DiscoveryWorker) RunOnce(ctx context.Context) error {
	if d.Policies == nil || d.Registry == nil || d.GitHub == nil {
		return gateway.ErrInvalid
	}
	policy, err := d.Policies.Load(ctx)
	if err != nil || policy.Policy.Discovery == nil || !policy.Revision.Enabled {
		return err
	}
	registry, err := d.Registry.BindRegistry(ctx, policy.Revision)
	if err != nil {
		return err
	}
	config := policy.Policy.Discovery
	var failures []error
	attempts := 0
	start := d.next % len(config.Repositories)
	for offset := range len(config.Repositories) {
		index := (start + offset) % len(config.Repositories)
		binding := config.Repositories[index]
		now := clock.Now(d.Clock)
		record, found := inventoryRecord(registry.Records, binding.RepositoryID)
		if found && !record.Dirty && !record.CheckedAt.After(now) && now.Before(record.CheckedAt.Add(time.Duration(config.Interval())*time.Second)) ||
			found && record.Dirty && !record.AttemptedAt.After(now) && now.Before(record.AttemptedAt.Add(30*time.Second)) {
			continue
		}
		if !policy.RepositoryAllowed(binding.Repository) {
			return gateway.ErrUnauthorized
		}
		scanCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		var quotaErr error
		next, scanErr := d.GitHub.DiscoverWebhookSubscriptions(scanCtx, binding, func(response githubquota.ResponseQuota) {
			if d.Quota != nil {
				quotaErr = errors.Join(quotaErr, ObserveQuota(scanCtx, d.Quota,
					strconv.FormatInt(policy.Policy.ReceivingAppID, 10), binding.ReceivingInstallationID, response))
			}
		})
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if scanErr == nil && (next.RepositoryID != binding.RepositoryID || next.Visibility != "private") {
			scanErr = gateway.ErrUnauthorized
		}
		scanErr = errors.Join(scanErr, quotaErr)
		next.AttemptedAt, next.CheckedAt = now, now
		if scanErr != nil {
			next = gateway.RepositoryInventory{RepositoryID: binding.RepositoryID, Dirty: true, AttemptedAt: now}
			failures = append(failures, gateway.ErrUnavailable)
		}
		records := replaceInventoryRecord(registry.Records, next)
		published, err := d.Registry.ReplaceRegistry(ctx, policy.Revision, registry.Version, records)
		if err != nil {
			if !errors.Is(err, gateway.ErrConflict) {
				// A failed oversized publication must not preserve old active
				// metadata. Use a small suspended record under the same CAS.
				records = replaceInventoryRecord(records, gateway.RepositoryInventory{
					RepositoryID: binding.RepositoryID, Dirty: true, AttemptedAt: now})
				_, clearErr := d.Registry.ReplaceRegistry(ctx, policy.Revision, registry.Version, records)
				return errors.Join(err, clearErr)
			}
			return err
		}
		registry = published
		attempts++
		d.next = (index + 1) % len(config.Repositories)
		if attempts == 8 {
			break
		}
	}
	return errors.Join(failures...)
}

type DiscoveryHints struct {
	Policies PolicyLoader
	Registry gateway.RegistryStore
}

func (h DiscoveryHints) Observe(ctx context.Context, event gateway.Event) (bool, error) {
	if event.Name != "push" && event.Name != "repository" {
		return false, nil
	}
	policy, err := h.Policies.Load(ctx)
	if err != nil {
		return true, err
	}
	if policy.Policy.Discovery == nil || event.SourceID != gateway.CompilerSourceID {
		return true, gateway.ErrUnauthorized
	}
	allowed := false
	for _, binding := range policy.Policy.Discovery.Repositories {
		if binding.RepositoryID == event.RepositoryID && binding.ReceivingInstallationID == event.InstallationID &&
			policy.RepositoryAllowed(binding.Repository) {
			allowed = true
		}
	}
	if !allowed {
		return true, gateway.ErrUnauthorized
	}
	changed, err := gateway.DiscoveryUpdate(event)
	if err != nil || !changed {
		return true, err
	}
	for range 3 {
		registry, err := h.Registry.BindRegistry(ctx, policy.Revision)
		if err != nil {
			return true, err
		}
		next := gateway.RepositoryInventory{RepositoryID: event.RepositoryID, Dirty: true}
		_, err = h.Registry.ReplaceRegistry(ctx, policy.Revision, registry.Version, replaceInventoryRecord(registry.Records, next))
		if !errors.Is(err, gateway.ErrConflict) {
			return true, err
		}
	}
	return true, gateway.ErrConflict
}

func inventoryRecord(records []gateway.RepositoryInventory, repository int64) (gateway.RepositoryInventory, bool) {
	for _, record := range records {
		if record.RepositoryID == repository {
			return record, true
		}
	}
	return gateway.RepositoryInventory{}, false
}

func replaceInventoryRecord(records []gateway.RepositoryInventory, next gateway.RepositoryInventory) []gateway.RepositoryInventory {
	records = slices.Clone(records)
	for i := range records {
		if records[i].RepositoryID == next.RepositoryID {
			records[i] = next
			return records
		}
	}
	return append(records, next)
}
