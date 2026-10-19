package webhookgateway

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"time"
)

const (
	MaxDispatchBatchItems = 64
	DispatchBatchWindow   = 2 * time.Second
)

type batchProvenance struct {
	Version        string   `json:"version"`
	SourceID       string   `json:"sourceId"`
	SubscriptionID string   `json:"subscriptionId"`
	Revision       Revision `json:"revision"`
	BatchID        string   `json:"batchId"`
}

// BatchCompatible prevents batching across authority, route, event kind or source identity.
func BatchCompatible(a, b Job) bool {
	return a.SubscriptionDigest == b.SubscriptionDigest && a.QueueRevision == b.QueueRevision &&
		a.Event.SourceID == b.Event.SourceID && a.Event.Name == b.Event.Name &&
		(a.Event.Name != "webhook" || a.Event.Action == b.Event.Action) &&
		a.Event.InstallationID == b.Event.InstallationID && a.Event.RepositoryID == b.Event.RepositoryID &&
		a.Event.OrganizationID == b.Event.OrganizationID && reflect.DeepEqual(a.Subscription, b.Subscription)
}

// BuildDispatchBatch builds the only outbound wire format. Individual job payloads
// remain immutable projections; delivery IDs are not part of element uniqueness.
func BuildDispatchBatch(jobs []Job) (json.RawMessage, error) {
	if len(jobs) == 0 || len(jobs) > MaxDispatchBatchItems {
		return nil, ErrInvalid
	}
	first := jobs[0]
	if first.Subscription.Compiler != nil {
		return buildCompilerBatch(jobs)
	}
	contexts := make(map[string]json.RawMessage)
	deliveries, ids := make([]string, 0, len(jobs)), make([]string, 0, len(jobs))
	seen := make(map[string]bool)
	var revision Revision
	for _, job := range jobs {
		if !BatchCompatible(first, job) || ValidateJob(job) != nil || seen[job.ID] {
			return nil, ErrInvalid
		}
		seen[job.ID] = true
		var request map[string]json.RawMessage
		if json.Unmarshal(job.Payload, &request) != nil {
			return nil, ErrInvalid
		}
		key := "client_payload"
		if job.Subscription.Destination.Kind == "workflow_dispatch" {
			key = "inputs"
		}
		var properties map[string]json.RawMessage
		if json.Unmarshal(request[key], &properties) != nil {
			return nil, ErrInvalid
		}
		raw := properties["_gateway"]
		if key == "inputs" {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				return nil, ErrInvalid
			}
			raw = []byte(text)
		}
		var provenance dispatchProvenance
		if json.Unmarshal(raw, &provenance) != nil {
			return nil, ErrInvalid
		}
		if !validRevision(provenance.Revision) || revision != (Revision{}) && revision != provenance.Revision {
			return nil, ErrInvalid
		}
		revision = provenance.Revision
		delete(properties, "_gateway")
		var context any = properties
		encoded, err := json.Marshal(context)
		if err != nil {
			return nil, ErrInvalid
		}
		// Decode once to normalize object key order inside raw projections.
		tree, err := boundedJSON(encoded, DefaultLimits().MaxDispatchBytes, DefaultLimits())
		if err != nil {
			return nil, err
		}
		encoded, err = json.Marshal(tree)
		if err != nil {
			return nil, ErrInvalid
		}
		contexts[string(encoded)] = encoded
		deliveries, ids = append(deliveries, job.DeliveryID), append(ids, job.ID)
	}
	slices.Sort(deliveries)
	deliveries = slices.Compact(deliveries)
	slices.Sort(ids)
	identity, _ := json.Marshal(ids)
	keys := make([]string, 0, len(contexts))
	for key := range contexts {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	elements := make([]json.RawMessage, 0, len(keys))
	for _, key := range keys {
		elements = append(elements, contexts[key])
	}
	properties := map[string]any{
		"schema_version": 2, "event": first.Event.Name, "delivery_ids": deliveries, "aw_context": elements,
		"_gateway": batchProvenance{Version: "cao.webhook-batch/v1", SourceID: first.Event.SourceID,
			SubscriptionID: first.Subscription.ID, Revision: revision, BatchID: MetadataDigest(identity)},
	}
	selector, value, propertyKey := "event_type", first.Subscription.Destination.EventType, "client_payload"
	if first.Subscription.Destination.Kind == "workflow_dispatch" {
		selector, value, propertyKey = "ref", first.Subscription.Destination.Ref, "inputs"
		for _, key := range []string{"schema_version", "delivery_ids", "aw_context", "_gateway"} {
			encoded, err := json.Marshal(properties[key])
			if err != nil {
				return nil, ErrInvalid
			}
			properties[key] = string(encoded)
		}
	}
	data, err := json.Marshal(map[string]any{selector: value, propertyKey: properties})
	if err != nil || ValidateBatchDispatchPayload(first.Subscription, data, DefaultLimits()) != nil {
		return nil, ErrInvalid
	}
	return data, nil
}

// BatchClaimOwner uniquely identifies a claim group across replicas and recoveries.
func BatchClaimOwner(owner string, first Job) string {
	data, _ := json.Marshal([]any{owner, first.ID, first.Fence, first.Version})
	return "batch." + MetadataDigest(data)
}

// BatchQueue reserves and settles complete claim groups atomically. Renewing
// individual leases is harmless; beginning an external attempt must be all-or-none.
type BatchQueue interface {
	Queue
	ClaimBatch(context.Context, ClaimRequest) ([]Job, error)
	BeginDispatchBatch(context.Context, []Fence, []Authorization) ([]Job, error)
	FinishBatch(context.Context, []Fence, Outcome) ([]Job, error)
}
