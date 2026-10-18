package webhookgateway

import (
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
)

func validTraceParent(value string) bool {
	if value == "" {
		return true
	}
	if len(value) != 55 || !strings.HasPrefix(value, "00-") || value[35] != '-' || value[52] != '-' ||
		value[3:35] == strings.Repeat("0", 32) || value[36:52] == strings.Repeat("0", 16) ||
		value != strings.ToLower(value) {
		return false
	}
	for _, part := range []string{value[3:35], value[36:52], value[53:55]} {
		if _, err := hex.DecodeString(part); err != nil {
			return false
		}
	}
	return true
}

func validEventIdentity(event EventIdentity, subscription Subscription) bool {
	source := subscription.Source
	return event.SourceID == source.ID && event.Name == source.Event &&
		identifier(event.DeliveryID) && (event.Action == "" || identifier(event.Action)) &&
		event.InstallationID == source.InstallationID &&
		event.RepositoryID >= 0 && event.OrganizationID >= 0 &&
		(source.RepositoryID == 0 || event.RepositoryID == source.RepositoryID) &&
		(source.OrganizationID == 0 || event.OrganizationID == source.OrganizationID)
}

func safeProjection(value any) bool {
	if scalar(value) {
		return true
	}
	array, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range array {
		if !scalar(item) {
			return false
		}
	}
	return true
}

type dispatchProvenance struct {
	Version        string   `json:"version"`
	SourceID       string   `json:"sourceId"`
	DeliveryID     string   `json:"deliveryId"`
	SubscriptionID string   `json:"subscriptionId"`
	Revision       Revision `json:"revision"`
}

func validateProvenance(job Job, value any, limits Limits, bindIdentity bool) error {
	var encoded []byte
	if job.Subscription.Destination.Kind == "workflow_dispatch" {
		text, ok := value.(string)
		if !ok || !job.Subscription.Destination.GatewayInput {
			return ErrInvalid
		}
		encoded = []byte(text)
	} else {
		var err error
		encoded, err = json.Marshal(value)
		if err != nil {
			return ErrInvalid
		}
	}
	root, err := boundedJSON(encoded, limits.MaxDispatchBytes, limits)
	if err != nil || !exactSchemaKeys(root, reflect.TypeFor[dispatchProvenance]()) {
		return ErrInvalid
	}
	var p dispatchProvenance
	if err := json.Unmarshal(encoded, &p); err != nil ||
		p.Version != "cao.webhook/v1" || p.SourceID != job.Subscription.Source.ID ||
		!identifier(p.DeliveryID) || p.SubscriptionID != job.Subscription.ID || !validRevision(p.Revision) {
		return ErrInvalid
	}
	if bindIdentity && (p.SourceID != job.Event.SourceID || p.DeliveryID != job.DeliveryID ||
		p.Revision.Digest != job.SubscriptionDigest) {
		return ErrInvalid
	}
	return nil
}

func validateCompiledPayload(job Job) error {
	return validateRequest(job, DefaultLimits(), true)
}

// ValidateDispatchPayload validates the complete API request, never a properties-only object.
// It binds selectors and declared properties to approved metadata, applies hard ceilings,
// and checks provenance structure. ValidateJob additionally binds provenance to job identity.
func ValidateDispatchPayload(s Subscription, payload json.RawMessage, limits Limits) error {
	if err := ValidateSubscription(s, limits); err != nil {
		return err
	}
	resolved, err := resolveLimits(limits)
	if err != nil {
		return err
	}
	return validateRequest(Job{Subscription: s, Payload: payload}, resolved, false)
}

func validateRequest(job Job, limits Limits, bindIdentity bool) error {
	s := job.Subscription
	if s.Destination.Kind == "repository_dispatch" && len(job.Payload) >= 65536 {
		return ErrInvalid
	}
	root, err := boundedJSON(job.Payload, limits.MaxDispatchBytes, limits)
	if err != nil {
		return err
	}
	request, ok := root.(map[string]any)
	if !ok || len(request) != 2 {
		return ErrInvalid
	}
	propertyKey := "client_payload"
	if s.Destination.Kind == "workflow_dispatch" {
		if request["ref"] != s.Destination.Ref {
			return ErrInvalid
		}
		propertyKey = "inputs"
	} else if request["event_type"] != s.Destination.EventType {
		return ErrInvalid
	}
	properties, ok := request[propertyKey].(map[string]any)
	if !ok || len(properties) > limits.MaxDispatchProperties {
		return ErrInvalid
	}
	if s.Compiler != nil {
		return validateCompilerProperties(job, properties, limits, bindIdentity)
	}
	fields := make(map[string]PayloadField, len(s.Destination.Fields))
	for _, f := range s.Destination.Fields {
		fields[f.Name] = f
		if f.Required {
			if _, exists := properties[f.Name]; !exists {
				return ErrInvalid
			}
		}
	}
	for name, value := range properties {
		if name == "_gateway" {
			if err := validateProvenance(job, value, limits, bindIdentity); err != nil {
				return err
			}
			continue
		}
		field, declared := fields[name]
		if !declared {
			return ErrInvalid
		}
		if s.Destination.Kind == "workflow_dispatch" && (value == nil || !scalar(value)) {
			return ErrInvalid
		}
		if field.Path == nil {
			literal, err := boundedJSON(field.Literal, limits.MaxDispatchBytes, limits)
			if err != nil || !reflect.DeepEqual(value, literal) {
				return ErrInvalid
			}
		} else if !safeProjection(value) {
			return ErrInvalid
		}
	}
	return nil
}
