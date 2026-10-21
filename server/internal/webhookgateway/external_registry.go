package webhookgateway

import (
	"slices"
	"strconv"
	"time"
)

func appendExternalSubscriptions(base *PolicySnapshot, destination DiscoveryRepository, record RepositoryInventory,
	workflow DiscoveredWorkflow, trigger CompilerTrigger, now time.Time,
) error {
	for _, source := range base.Policy.ExternalSources {
		if !now.Before(source.ExpiresAt) || !slices.Contains(source.DestinationRepositoryIDs, destination.RepositoryID) ||
			!externalDeclarationMatches(source, trigger) {
			continue
		}
		id := "compiler." + strconv.FormatInt(destination.RepositoryID, 10) + "." +
			MetadataDigest([]byte(workflow.Path + "\x00" + compilerTriggerKey(trigger)))[:24] + "." + source.ID
		ttl := min(int64(3600), int64(base.Policy.Queue.MaxAge/time.Second))
		subscription := Subscription{
			SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: eventProvider(trigger.Event),
			ID: id, TenantID: "external." + source.ID, AppID: base.Policy.DispatchAppID,
			Source: Source{ID: source.ID, Event: trigger.Event, External: &source},
			Destination: Destination{Kind: "repository_dispatch", InstallationID: destination.DispatchInstallationID,
				RepositoryID: destination.RepositoryID, EventType: trigger.Dispatch.EventType},
			Compiler: &trigger,
			Delivery: DeliveryPolicy{TTLSeconds: ttl, LeaseSeconds: min(60, ttl), MaxAttempts: 5, RetryDelaySeconds: min(10, ttl)},
		}
		revision := Revision{RepositoryID: destination.RepositoryID, CommitSHA: record.CommitSHA,
			MetadataPath: workflow.Path, Digest: workflow.SHA256, CompilerID: "gh-aw-manifest-v1"}
		if ValidateSubscription(subscription, DefaultLimits()) != nil || !validRevision(revision) {
			return ErrInvalid
		}
		if len(base.Subscriptions) >= MaxDiscoveredSubscriptions || base.Revisions[id].Digest != "" {
			return ErrCapacity
		}
		expiry := record.CheckedAt.Add(time.Duration(2*base.Policy.Discovery.Interval()) * time.Second)
		if source.ExpiresAt.Before(expiry) {
			expiry = source.ExpiresAt
		}
		base.Subscriptions = append(base.Subscriptions, subscription)
		base.Revisions[id] = revision
		base.Grants[id] = AdminGrant{
			SubscriptionID: id, Digest: revision.Digest, ExternalSourceID: source.ID,
			DestinationInstallationID: destination.DispatchInstallationID, DestinationRepositoryID: destination.RepositoryID,
			DispatchKind: "repository_dispatch", ExpiresAt: expiry,
		}
	}
	return nil
}
