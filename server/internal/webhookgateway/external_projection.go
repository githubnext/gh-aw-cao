package webhookgateway

import (
	"encoding/json"
	"slices"
)

func notificationActivities(payload map[string]any) ([]string, bool) {
	return stringArray(payload["type"])
}

func validExternalActivities(s Subscription, native string, activities []string) bool {
	if s.Compiler == nil || len(activities) == 0 || len(activities) > 8 {
		return false
	}
	if !slices.Contains(s.Compiler.NativeEvents, native) ||
		slices.Contains(activities, "closed") && slices.Contains(activities, "reopened") {
		return false
	}
	for i, activity := range activities {
		if !compilerActivity(s.Source.Event, activity) || i > 0 && activity <= activities[i-1] ||
			providerNativeForActivity(s.Source.Event, activity) != native || !slices.Contains(s.Compiler.Types, activity) {
			return false
		}
	}
	return true
}

func validExternalNotification(s Subscription, payload map[string]any) bool {
	resource, ok := payload["url"].(string)
	activities, validTypes := notificationActivities(payload)
	if !validCompilerFilters(*s.Compiler, payload) || !ok || !validTypes || !validExternalResource(*s.Source.External, resource) || len(activities) == 0 {
		return false
	}
	native := activities[0]
	if providerEvent(s.Source.Event) {
		native = providerNativeForActivity(s.Source.Event, activities[0])
	}
	return validExternalActivities(s, native, activities)
}

func buildExternalDispatchPayload(s Subscription, event Event, root any, l Limits) (json.RawMessage, error) {
	object, ok := root.(map[string]any)
	if !ok || nativeAction(event.Name, object) != event.Action ||
		!compilerTriggerMatches(*s.Compiler, root, event.Action) {
		return nil, ErrInvalid
	}
	resource, err := externalResource(*s.Source.External, root)
	if err != nil {
		return nil, err
	}
	activities := []string{event.Action}
	if providerEvent(event.Name) {
		activities = selectedProviderActivities(*s.Compiler, root)
	}
	if !validExternalActivities(s, event.Action, activities) {
		return nil, ErrInvalid
	}
	payload := map[string]any{"url": resource, "type": activities}
	if err := addCompilerFilters(payload, *s.Compiler, root); err != nil {
		return nil, err
	}
	data, err := json.Marshal(map[string]any{"event_type": s.Destination.EventType, "client_payload": map[string]any{
		"schema_version": 1, "event": event.Name, "delivery_id": event.DeliveryID, "payload": payload,
	}})
	if err != nil || len(data) > l.MaxDispatchBytes {
		return nil, ErrInvalid
	}
	return data, nil
}
