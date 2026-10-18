package webhookgateway

import (
	"context"
	"encoding/json"
)

// SecretProvider resolves only the server-configured source, never a payload identity.
type SecretProvider interface {
	WebhookSecrets(context.Context, string) (current, previous []byte, err error)
}

// PolicyProvider returns current authoritative policy without a stale fallback.
type PolicyProvider interface {
	Load(context.Context) (PolicySnapshot, error)
}

// Authorizer supplies fresh evidence for a specific immutable job and claim.
// An incomplete observation is not revocation and must never authorize dispatch.
type Authorizer interface {
	Authorize(context.Context, Job) (AuthorizationSnapshot, error)
}

// Dispatcher performs exactly one external attempt. It must honor cancellation.
type Dispatcher interface {
	Dispatch(context.Context, Subscription, json.RawMessage) DispatchResponse
}

// Budget reserves shared installation quota before the durable dispatch
// transition. The host owns reconciliation with its paired Dispatcher.
type Budget interface {
	Acquire(context.Context, Job) (release func(), err error)
}

// QueueDepthProvider is optional telemetry; failure cannot alter queue authority.
type QueueDepthProvider interface {
	QueueDepth(context.Context) (int64, error)
}

// QueueStats contains only bounded aggregate observations, never partition IDs.
type QueueStats struct {
	Depth             int64
	RetainedRows      int64
	RetainedBytes     int64
	OldestAgeSeconds  float64
	ActiveWorkers     int64
	WorkerUtilization float64
	TenantUtilization []float64
}

type QueueStatsProvider interface {
	QueueStats(context.Context) (QueueStats, error)
}

func jobFence(job Job) Fence {
	return Fence{JobID: job.ID, Owner: job.ClaimID, Generation: job.Fence, Version: job.Version}
}

func buildGatewayDispatchPayload(subscription Subscription, event Event, revision Revision, limits Limits) (json.RawMessage, error) {
	if !validRevision(revision) {
		return nil, ErrInvalid
	}
	return BuildDispatchPayload(subscription, event, limits)
}
