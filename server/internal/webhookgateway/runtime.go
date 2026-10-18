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

type DiscoveryObserver interface {
	Observe(context.Context, Event) (bool, error)
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
	if subscription.Destination.Kind == "workflow_dispatch" && !subscription.Destination.GatewayInput {
		return nil, ErrInvalid
	}
	base, err := BuildDispatchPayload(subscription, event, limits)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveLimits(limits)
	if err != nil {
		return nil, err
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(base, &request); err != nil {
		return nil, ErrInvalid
	}
	propertyKey := "client_payload"
	if subscription.Destination.Kind == "workflow_dispatch" {
		propertyKey = "inputs"
	}
	var properties map[string]json.RawMessage
	if err := json.Unmarshal(request[propertyKey], &properties); err != nil {
		return nil, ErrInvalid
	}
	if _, exists := properties["_gateway"]; exists {
		return nil, ErrInvalid
	}
	provenance, err := json.Marshal(struct {
		Version        string   `json:"version"`
		SourceID       string   `json:"sourceId"`
		DeliveryID     string   `json:"deliveryId"`
		SubscriptionID string   `json:"subscriptionId"`
		Revision       Revision `json:"revision"`
	}{
		Version: "cao.webhook/v1", SourceID: subscription.Source.ID,
		DeliveryID: event.DeliveryID, SubscriptionID: subscription.ID, Revision: revision,
	})
	if err != nil {
		return nil, ErrInvalid
	}
	properties["_gateway"] = provenance
	if propertyKey == "inputs" {
		// Workflow input values cannot carry nested objects.
		encoded, err := json.Marshal(string(provenance))
		if err != nil {
			return nil, ErrInvalid
		}
		properties["_gateway"] = encoded
	}
	maxProperties := resolved.MaxDispatchProperties
	if propertyKey == "client_payload" && maxProperties > 10 {
		maxProperties = 10
	}
	if len(properties) > maxProperties {
		return nil, ErrInvalid
	}
	request[propertyKey], err = json.Marshal(properties)
	if err != nil {
		return nil, ErrInvalid
	}
	payload, err := json.Marshal(request)
	if err != nil || len(payload) > resolved.MaxDispatchBytes ||
		(propertyKey == "client_payload" && len(payload) >= 65536) {
		return nil, ErrInvalid
	}
	if subscription.Compiler != nil && !compilerPayloadFits(subscription, payload, properties, resolved) {
		return nil, ErrInvalid
	}
	return payload, nil
}
