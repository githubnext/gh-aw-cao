package webhookgateway

import (
	"context"
	"encoding/json"
	"maps"
	"strconv"
	"strings"
	"time"
)

type DiscoveredWorkflow struct {
	Path     string            `json:"path"`
	SHA256   string            `json:"sha256"`
	Triggers []CompilerTrigger `json:"triggers"`
}

// RepositoryInventory contains compiler metadata only, never delivery bodies,
// credentials, fetched source steps, or security alert contents.
type RepositoryInventory struct {
	RepositoryID int64                `json:"repositoryId"`
	OwnerID      int64                `json:"ownerId"`
	OwnerType    string               `json:"ownerType"`
	Visibility   string               `json:"visibility"`
	CommitSHA    string               `json:"commitSha"`
	CheckedAt    time.Time            `json:"checkedAt"`
	AttemptedAt  time.Time            `json:"attemptedAt"`
	Dirty        bool                 `json:"dirty"`
	Workflows    []DiscoveredWorkflow `json:"workflows"`
}

type RegistrySnapshot struct {
	Version  int64                 `json:"version"`
	Control  QueueRevision         `json:"control"`
	Revision QueueRevision         `json:"revision"`
	Records  []RepositoryInventory `json:"records"`
}

// RegistryStore publishes inventory and its effective queue revision atomically.
// Version fences even timestamp-only refreshes, preventing stale scan/hint writes.
type RegistryStore interface {
	BindRegistry(context.Context, QueueRevision) (RegistrySnapshot, error)
	ReplaceRegistry(context.Context, QueueRevision, int64, []RepositoryInventory) (RegistrySnapshot, error)
}

func RegistryDigest(control QueueRevision, records []RepositoryInventory) (string, error) {
	if !validQueueRevision(control) || len(records) > MaxDiscoveryRepositories {
		return "", ErrInvalid
	}
	seen := make(map[int64]bool)
	routing := make([]RepositoryInventory, len(records))
	for i, record := range records {
		if record.RepositoryID <= 0 || seen[record.RepositoryID] || len(record.Workflows) > 128 {
			return "", ErrInvalid
		}
		seen[record.RepositoryID] = true
		workflows := make(map[string]bool)
		for _, workflow := range record.Workflows {
			id := strings.TrimSuffix(strings.TrimPrefix(workflow.Path, ".github/workflows/"), ".lock.yml")
			if !identifier(id) || id == "." || id == ".." || workflow.Path != ".github/workflows/"+id+".lock.yml" ||
				workflows[workflow.Path] || !digestOK(workflow.SHA256) {
				return "", ErrInvalid
			}
			workflows[workflow.Path] = true
			events := make(map[string]bool)
			for _, trigger := range workflow.Triggers {
				key := compilerTriggerKey(trigger)
				if events[key] || validateCompilerTrigger(trigger, workflow.Path, id, DefaultLimits()) != nil {
					return "", ErrInvalid
				}
				events[key] = true
			}
		}
		record.CheckedAt, record.AttemptedAt = time.Time{}, time.Time{}
		routing[i] = record
	}
	data, err := json.Marshal(struct {
		Control QueueRevision         `json:"control"`
		Records []RepositoryInventory `json:"records"`
	}{control, routing})
	if err != nil || len(data) > 1<<20 {
		return "", ErrInvalid
	}
	return MetadataDigest(data), nil
}

// RegistryPolicy intersects discovered metadata with reviewed automatic security
// enrollment. Project declarations never become active merely by being found.
func RegistryPolicy(base PolicySnapshot, registry RegistrySnapshot, now time.Time) (PolicySnapshot, error) {
	if registry.Control != base.Revision || registry.Version < 1 || !validQueueRevision(registry.Revision) {
		return PolicySnapshot{}, ErrConflict
	}
	digest, err := RegistryDigest(registry.Control, registry.Records)
	if err != nil || digest != registry.Revision.Digest || registry.Revision.Enabled != registry.Control.Enabled {
		return PolicySnapshot{}, ErrInvalid
	}
	base.Revision = registry.Revision
	base.Subscriptions = append([]Subscription(nil), base.Subscriptions...)
	base.Grants, base.Revisions = maps.Clone(base.Grants), maps.Clone(base.Revisions)
	if base.Grants == nil {
		base.Grants = make(map[string]AdminGrant)
	}
	if base.Revisions == nil {
		base.Revisions = make(map[string]Revision)
	}
	if base.Policy.Discovery == nil {
		return PolicySnapshot{}, ErrInvalid
	}
	config := base.Policy.Discovery
	if !base.Revision.Enabled {
		return base, nil
	}
	bindings := make(map[int64]DiscoveryRepository)
	for _, binding := range config.Repositories {
		bindings[binding.RepositoryID] = binding
	}
	available := make(map[int64]RepositoryInventory)
	for _, record := range registry.Records {
		if !freshInventory(record, now, config.Interval()) {
			continue
		}
		binding, enrolled := bindings[record.RepositoryID]
		if !enrolled || !base.RepositoryAllowed(binding.Repository) || record.Visibility != "private" ||
			record.OwnerID <= 0 || (record.OwnerType != "Organization" && record.OwnerType != "User") {
			return PolicySnapshot{}, ErrUnauthorized
		}
		available[record.RepositoryID] = record
	}
	for _, binding := range config.Repositories {
		record, found := available[binding.RepositoryID]
		if !found {
			continue
		}
		for _, workflow := range record.Workflows {
			for _, trigger := range workflow.Triggers {
				if eventProvider(trigger.Event) != "" {
					if err := appendExternalSubscriptions(&base, binding, record, workflow, trigger, now); err != nil {
						return PolicySnapshot{}, err
					}
					continue
				}
				command := commandFamily(trigger.Event)
				notification := notificationFamily(trigger.Event)
				if trigger.SchemaVersion != 2 || command && !config.ActivateCommands ||
					notification && !config.ActivateNotifications ||
					!command && !notification && (!config.ActivateSecurity || SecurityEventPermission(trigger.Event) == "") {
					continue
				}
				for _, source := range config.Repositories {
					if trigger.Repos == nil && source.RepositoryID != binding.RepositoryID ||
						!base.RepositoryAllowed(source.Repository) || !CompilerRepositoryMatches(trigger, source.Repository) {
						continue
					}
					sourceRecord, found := available[source.RepositoryID]
					owner, _, _ := strings.Cut(source.Repository, "/")
					if !found || !CompilerOrganizationMatches(trigger, owner, sourceRecord.OwnerID, sourceRecord.OwnerType) {
						continue
					}
					if command && trigger.CommandFilter.RemoveLabel != nil && *trigger.CommandFilter.RemoveLabel && !source.AllowLabelRemoval {
						continue
					}
					subscription, revision, grant, err := discoveredSecuritySubscription(base.Policy, source, sourceRecord, binding, record, workflow, trigger)
					if err != nil {
						return PolicySnapshot{}, err
					}
					if base.Revisions[subscription.ID].Digest != "" || len(base.Subscriptions) >= MaxDiscoveredSubscriptions {
						return PolicySnapshot{}, ErrCapacity
					}
					base.Subscriptions = append(base.Subscriptions, subscription)
					base.Revisions[subscription.ID], base.Grants[subscription.ID] = revision, grant
				}
			}
		}
	}
	return base, nil
}

func freshInventory(record RepositoryInventory, now time.Time, interval int64) bool {
	return !record.Dirty && !record.CheckedAt.IsZero() && !record.CheckedAt.After(now) &&
		now.Before(record.CheckedAt.Add(time.Duration(2*interval)*time.Second))
}

func discoveredSecuritySubscription(policy GatewayPolicy, source DiscoveryRepository, sourceRecord RepositoryInventory,
	binding DiscoveryRepository, record RepositoryInventory,
	workflow DiscoveredWorkflow, trigger CompilerTrigger,
) (Subscription, Revision, AdminGrant, error) {
	id := "compiler." + strconv.FormatInt(binding.RepositoryID, 10) + "." + MetadataDigest([]byte(workflow.Path))[:24] + "." + trigger.Event
	if source.RepositoryID != binding.RepositoryID {
		id += ".source." + strconv.FormatInt(source.RepositoryID, 10)
	}
	organization := int64(0)
	if sourceRecord.OwnerType == "Organization" {
		organization = sourceRecord.OwnerID
	}
	ttl := min(int64(3600), int64(policy.Queue.MaxAge/time.Second))
	s := Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: id,
		TenantID: "repo." + strconv.FormatInt(source.RepositoryID, 10), AppID: policy.DispatchAppID,
		Source: Source{ID: CompilerSourceID, Event: trigger.Event, InstallationID: source.ReceivingInstallationID,
			RepositoryID: source.RepositoryID, OrganizationID: organization,
			RequiredPermissions: map[string]string{"contents": "read", SecurityEventPermission(trigger.Event): "read"}},
		Destination: Destination{Kind: "repository_dispatch", InstallationID: binding.DispatchInstallationID,
			RepositoryID: binding.RepositoryID, EventType: trigger.Dispatch.EventType},
		Delivery: DeliveryPolicy{TTLSeconds: ttl, LeaseSeconds: min(60, ttl), MaxAttempts: 5, RetryDelaySeconds: min(10, ttl)},
		Compiler: &trigger,
	}
	if commandFamily(trigger.Event) {
		s.Source.RequiredPermissions = commandPermissions(trigger)
		s.Source.ServerURL = policy.Discovery.GitHubServerURL()
	} else if notificationFamily(trigger.Event) {
		s.Source.RequiredPermissions = notificationPermissions(trigger.Event)
		s.Source.ServerURL = policy.Discovery.GitHubServerURL()
	}
	revision := Revision{RepositoryID: binding.RepositoryID, CommitSHA: record.CommitSHA,
		MetadataPath: workflow.Path, Digest: workflow.SHA256, CompilerID: "gh-aw-manifest-v1"}
	if trigger.Dispatch.Workflow != workflow.Path || ValidateSubscription(s, DefaultLimits()) != nil || !validRevision(revision) {
		return Subscription{}, Revision{}, AdminGrant{}, ErrInvalid
	}
	expires := record.CheckedAt.Add(time.Duration(2*policy.Discovery.Interval()) * time.Second)
	if sourceExpiry := sourceRecord.CheckedAt.Add(time.Duration(2*policy.Discovery.Interval()) * time.Second); sourceExpiry.Before(expires) {
		expires = sourceExpiry
	}
	grant := AdminGrant{SubscriptionID: id, Digest: revision.Digest,
		SourceInstallationID: source.ReceivingInstallationID, SourceRepositoryID: source.RepositoryID,
		SourceOrganizationID: organization, ReceivingInstallationID: source.ReceivingInstallationID,
		DestinationInstallationID: binding.DispatchInstallationID, DestinationRepositoryID: binding.RepositoryID,
		DispatchKind: "repository_dispatch", ExpiresAt: expires}
	return s, revision, grant, nil
}

func validQueueRevision(r QueueRevision) bool {
	return r.Revision > 0 && digestOK(r.Digest)
}
