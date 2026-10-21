package webhookgateway

import (
	"encoding/json"
	"reflect"
	"slices"
	"time"
)

// ValidateBatchDispatchPayload rejects legacy singleton envelopes and validates
// every unique context against the same approved projection and event family.
func ValidateBatchDispatchPayload(s Subscription, payload json.RawMessage, limits Limits) error {
	l, err := resolveLimits(limits)
	if err != nil || ValidateSubscription(s, l) != nil ||
		s.Compiler != nil && s.Compiler.SchemaVersion != 2 {
		return ErrInvalid
	}
	if s.Compiler != nil {
		return validateCompilerBatch(s, payload, l)
	}
	tree, err := boundedJSON(payload, l.MaxDispatchBytes, l)
	request, ok := tree.(map[string]any)
	if err != nil || !ok || len(request) != 2 || len(payload) >= 65536 {
		return ErrInvalid
	}
	key, selector, expected := "client_payload", "event_type", s.Destination.EventType
	if s.Destination.Kind == "workflow_dispatch" {
		key, selector, expected = "inputs", "ref", s.Destination.Ref
		if !s.Destination.GatewayInput || !s.Destination.BatchInput {
			return ErrInvalid
		}
	}
	properties, ok := request[key].(map[string]any)
	if !ok || len(properties) != 5 || request[selector] != expected {
		return ErrInvalid
	}
	if key == "inputs" {
		for _, name := range []string{"schema_version", "delivery_ids", "aw_context", "_gateway"} {
			text, ok := properties[name].(string)
			if !ok {
				return ErrInvalid
			}
			value, err := boundedJSON([]byte(text), l.MaxDispatchBytes, l)
			if err != nil {
				return ErrInvalid
			}
			properties[name] = value
		}
	}
	if properties["schema_version"] != json.Number("2") || properties["event"] != s.Source.Event {
		return ErrInvalid
	}
	deliveries, ok := properties["delivery_ids"].([]any)
	if !ok || len(deliveries) == 0 || len(deliveries) > MaxDispatchBatchItems {
		return ErrInvalid
	}
	previous := ""
	for _, value := range deliveries {
		id, ok := value.(string)
		if !ok || !identifier(id) || id <= previous {
			return ErrInvalid
		}
		previous = id
	}
	provenance, err := json.Marshal(properties["_gateway"])
	if err != nil || !exactSchemaKeys(properties["_gateway"], reflect.TypeFor[batchProvenance]()) {
		return ErrInvalid
	}
	var p batchProvenance
	if json.Unmarshal(provenance, &p) != nil || p.Version != "cao.webhook-batch/v1" ||
		p.SourceID != s.Source.ID || p.SubscriptionID != s.ID || !validRevision(p.Revision) || !digestOK(p.BatchID) {
		return ErrInvalid
	}
	elements, ok := properties["aw_context"].([]any)
	if !ok || len(elements) == 0 || len(elements) > len(deliveries) {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, value := range elements {
		context, ok := value.(map[string]any)
		if !ok || validateBatchContext(s, context, l) != nil {
			return ErrInvalid
		}
		encoded, err := json.Marshal(context)
		if err != nil || seen[string(encoded)] {
			return ErrInvalid
		}
		seen[string(encoded)] = true
	}
	return nil
}

func validateBatchContext(s Subscription, context map[string]any, l Limits) error {
	for _, field := range s.Destination.Fields {
		value, exists := context[field.Name]
		if !exists {
			if field.Required {
				return ErrInvalid
			}
			continue
		}
		if field.Path == nil {
			expected, err := boundedJSON(field.Literal, l.MaxDispatchBytes, l)
			if err != nil || !reflect.DeepEqual(value, expected) {
				return ErrInvalid
			}
		} else if !safeProjection(value) {
			return ErrInvalid
		}
		if s.Destination.Kind == "workflow_dispatch" && (value == nil || !scalar(value)) {
			return ErrInvalid
		}
	}
	for name := range context {
		if !slices.ContainsFunc(s.Destination.Fields, func(f PayloadField) bool { return f.Name == name }) {
			return ErrInvalid
		}
	}
	return nil
}

// BatchFences returns exact member versions; no leader fence can authorize siblings.
func BatchFences(jobs []Job) []Fence {
	fences := make([]Fence, len(jobs))
	for i, job := range jobs {
		fences[i] = jobFence(job)
	}
	return fences
}

func ValidateBatchClaim(request ClaimRequest) error {
	if !identifier(request.Owner) || request.LeaseDuration < time.Millisecond ||
		request.BatchWindow < 0 || request.BatchWindow > 30*time.Second {
		return ErrInvalid
	}
	return nil
}
