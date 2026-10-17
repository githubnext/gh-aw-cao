// Package webhookgatewaylocal implements an explicitly non-authoritative local
// simulation. Its dispatcher has no client and cannot issue GitHub writes.
package webhookgatewaylocal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

// Simulation owns a private fixture policy, signing secret, and synthetic
// authorization. None of these can be passed to the production CLI roles.
type Simulation struct {
	snapshot wg.PolicySnapshot
	secret   string
}

func NewSimulation(repository Repository, events []string) (*Simulation, error) {
	if repository.ID < 1 || repository.Owner.ID < 1 || len(events) == 0 || len(events) > len(eventTypes) {
		return nil, wg.ErrInvalid
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	s := &Simulation{secret: hex.EncodeToString(secret)}
	s.snapshot = wg.PolicySnapshot{Revisions: make(map[string]wg.Revision)}
	seen := make(map[string]bool)
	for _, event := range events {
		if !supportedEvent(event) || seen[event] {
			return nil, wg.ErrInvalid
		}
		seen[event] = true
		sub := wg.Subscription{
			SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "local-" + event,
			TenantID: "local", AppID: 2,
			Source: wg.Source{ID: "local", Event: event, InstallationID: 1, RepositoryID: repository.ID},
			Destination: wg.Destination{Kind: "repository_dispatch", InstallationID: 1, RepositoryID: repository.ID,
				EventType: "local.simulation", Fields: []wg.PayloadField{{Name: "simulation", Literal: json.RawMessage("true"), Required: true}}},
			Delivery: wg.DeliveryPolicy{TTLSeconds: 86400, LeaseSeconds: 60, MaxAttempts: 3, RetryDelaySeconds: 2},
		}
		if repository.Owner.Type == "Organization" {
			sub.Source.OrganizationID = repository.Owner.ID
		}
		if err := wg.ValidateSubscription(sub, wg.DefaultLimits()); err != nil {
			return nil, err
		}
		data, err := json.Marshal(sub)
		if err != nil {
			return nil, err
		}
		s.snapshot.Subscriptions = append(s.snapshot.Subscriptions, sub)
		s.snapshot.Revisions[sub.ID] = wg.Revision{
			RepositoryID: repository.ID, CommitSHA: strings.Repeat("0", 40),
			MetadataPath: "local/simulation.json", Digest: wg.MetadataDigest(data), CompilerID: "local-simulation",
		}
	}
	identity, err := json.Marshal(struct {
		Repository    Repository
		Subscriptions []wg.Subscription
	}{repository, s.snapshot.Subscriptions})
	if err != nil {
		return nil, err
	}
	digest := wg.MetadataDigest(identity)
	s.snapshot.Revision = wg.QueueRevision{Revision: 1, Digest: digest, Enabled: true}
	budget := wg.RateBudget{Capacity: 300, Period: time.Minute}
	s.snapshot.Policy = wg.GatewayPolicy{
		Version: 1, Enabled: true, Revision: 1, ReceivingAppID: 1, DispatchAppID: 2,
		Namespace: "local-" + digest[:32], Workers: 1,
		Queue: wg.QueueOptions{
			MaxRows: 10000, MaxBytes: 64 << 20, MaxTenantRows: 10000, MaxTenantBytes: 64 << 20,
			MaxSourceRows: 10000, MaxSourceBytes: 64 << 20, MaxDestinationRows: 10000, MaxDestinationBytes: 64 << 20,
			MaxPayloadBytes: 1 << 20, MaxBatch: 64, MaxConcurrency: 8,
			MaxAge: 24 * time.Hour, DedupWindow: 72 * time.Hour, TerminalRetention: 72 * time.Hour, LeaseDuration: time.Minute,
			Rates: wg.RateBudgets{Global: budget, App: budget, Tenant: budget, Destination: budget, Workflow: budget},
		},
	}
	return s, nil
}

func (s *Simulation) Load(ctx context.Context) (wg.PolicySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return wg.PolicySnapshot{}, err
	}
	return s.snapshot, nil
}

func (s *Simulation) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	return []byte(s.secret), nil, nil
}

func (s *Simulation) Authorize(ctx context.Context, job wg.Job) (wg.AuthorizationSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return wg.AuthorizationSnapshot{}, err
	}
	revision, ok := s.snapshot.Revisions[job.Subscription.ID]
	if !ok || revision.Digest != job.SubscriptionDigest {
		return wg.AuthorizationSnapshot{}, wg.ErrUnauthorized
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	source, destination := job.Subscription.Source, job.Subscription.Destination
	return wg.AuthorizationSnapshot{
		Complete: true, JobID: job.ID, Fence: job.Fence, Attempt: job.Attempt + 1,
		CheckedAt: now, ExpiresAt: now.Add(20 * time.Second), CurrentRevision: revision,
		SourceInstallationID: source.InstallationID, ReceivingInstallationID: source.InstallationID,
		SourceRepositoryID: source.RepositoryID, SourceOrganizationID: source.OrganizationID,
		DestinationInstallationID: destination.InstallationID, DestinationRepositoryID: destination.RepositoryID,
		SourceAccessible: true, DestinationAccessible: true, SourcePermissionsOK: true, DispatchPermissionsOK: true,
		SourceVisibility: "private", DestinationVisibility: "private",
		Grant: wg.AdminGrant{SubscriptionID: job.Subscription.ID, Digest: revision.Digest,
			SourceInstallationID: source.InstallationID, ReceivingInstallationID: source.InstallationID,
			SourceRepositoryID: source.RepositoryID, SourceOrganizationID: source.OrganizationID,
			DestinationInstallationID: destination.InstallationID, DestinationRepositoryID: destination.RepositoryID,
			DispatchKind: destination.Kind, ExpiresAt: now.Add(time.Minute)},
	}, nil
}

func (*Simulation) Dispatch(ctx context.Context, _ wg.Subscription, _ json.RawMessage) wg.DispatchResponse {
	if ctx.Err() != nil {
		return wg.DispatchResponse{TransportOutcome: "not-sent"}
	}
	return wg.DispatchResponse{StatusCode: 204, TransportOutcome: "response"}
}
