package webhookgateway

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
)

type compilerDelivery struct {
	DeliveryID string          `json:"delivery_id"`
	Payload    json.RawMessage `json:"payload"`
}

type compilerWebhook struct {
	Event      string             `json:"event"`
	Deliveries []compilerDelivery `json:"deliveries"`
}

type compilerAWContext struct {
	Webhook compilerWebhook `json:"webhook"`
}

type compilerBatchPayload struct {
	SchemaVersion int               `json:"schema_version"`
	AWContext     compilerAWContext `json:"aw_context"`
}

type compilerBatchRequest struct {
	EventType string               `json:"event_type"`
	Payload   compilerBatchPayload `json:"client_payload"`
}

func buildCompilerBatch(jobs []Job) (json.RawMessage, error) {
	first := jobs[0]
	if _, err := DispatchRevision(jobs); err != nil {
		return nil, err
	}
	deliveries := make([]compilerDelivery, 0, len(jobs))
	seen := make(map[string]bool)
	for _, job := range jobs {
		if !BatchCompatible(first, job) || ValidateJob(job) != nil || seen[job.ID] {
			return nil, ErrInvalid
		}
		seen[job.ID] = true
		var member struct {
			Payload struct {
				Projection json.RawMessage `json:"payload"`
			} `json:"client_payload"`
		}
		if json.Unmarshal(job.Payload, &member) != nil {
			return nil, ErrInvalid
		}
		deliveries = append(deliveries, compilerDelivery{DeliveryID: job.DeliveryID, Payload: member.Payload.Projection})
	}
	slices.SortFunc(deliveries, func(a, b compilerDelivery) int { return strings.Compare(a.DeliveryID, b.DeliveryID) })
	request := compilerBatchRequest{EventType: first.Subscription.Destination.EventType,
		Payload: compilerBatchPayload{SchemaVersion: 2, AWContext: compilerAWContext{
			Webhook: compilerWebhook{Event: first.Event.Name, Deliveries: deliveries},
		}}}
	data, err := json.Marshal(request)
	if err != nil || ValidateBatchDispatchPayload(first.Subscription, data, DefaultLimits()) != nil {
		return nil, ErrInvalid
	}
	return data, nil
}

func validateCompilerBatch(s Subscription, payload json.RawMessage, l Limits) error {
	root, err := boundedJSON(payload, l.MaxDispatchBytes, l)
	if err != nil || !exactSchemaKeys(root, reflect.TypeFor[compilerBatchRequest]()) || len(payload) >= 65536 ||
		len(payload) > s.Compiler.Dispatch.MaxRequestBytes {
		return ErrInvalid
	}
	var request compilerBatchRequest
	if json.Unmarshal(payload, &request) != nil || request.EventType != s.Destination.EventType ||
		request.Payload.SchemaVersion != 2 || request.Payload.AWContext.Webhook.Event != s.Source.Event {
		return ErrInvalid
	}
	var framing map[string]json.RawMessage
	if json.Unmarshal(payload, &framing) != nil || len(framing["client_payload"]) > s.Compiler.Dispatch.MaxPayloadBytes {
		return ErrInvalid
	}
	deliveries := request.Payload.AWContext.Webhook.Deliveries
	if len(deliveries) == 0 || len(deliveries) > MaxDispatchBatchItems {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, delivery := range deliveries {
		if !identifier(delivery.DeliveryID) || seen[delivery.DeliveryID] {
			return ErrInvalid
		}
		seen[delivery.DeliveryID] = true
		value, err := boundedJSON(delivery.Payload, l.MaxDispatchBytes, l)
		object, ok := value.(map[string]any)
		if err != nil || !ok || len(object) != 1 || !validCompilerAlertURL(s.Source.Event, object["url"]) {
			return ErrInvalid
		}
	}
	return nil
}

// CompilerBatchRepository binds URL-only projections to the freshly resolved
// destination identity, not a sender-provided repository name.
func CompilerBatchRepository(s Subscription, payload json.RawMessage, repository string) error {
	if s.Compiler == nil || ValidateBatchDispatchPayload(s, payload, DefaultLimits()) != nil {
		return ErrInvalid
	}
	var request compilerBatchRequest
	if json.Unmarshal(payload, &request) != nil {
		return ErrInvalid
	}
	for _, delivery := range request.Payload.AWContext.Webhook.Deliveries {
		var projection struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(delivery.Payload, &projection) != nil {
			return ErrInvalid
		}
		parts := strings.Split(strings.TrimPrefix(projection.URL, "https://api.github.com/repos/"), "/")
		if len(parts) != 5 || !strings.EqualFold(parts[0]+"/"+parts[1], repository) {
			return ErrUnauthorized
		}
	}
	return nil
}
