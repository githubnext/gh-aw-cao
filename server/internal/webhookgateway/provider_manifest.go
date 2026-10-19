package webhookgateway

import (
	"reflect"
	"regexp"
	"slices"
	"strings"
)

var genericProperty = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

func providerNativeEvents(event string) []string {
	switch event {
	case "jira_issue":
		return []string{"jira:issue_created", "jira:issue_updated", "jira:issue_deleted"}
	case "linear_issue":
		return []string{"create", "update", "remove"}
	case "azure_devops_issue":
		return []string{"workitem.created", "workitem.updated", "workitem.deleted", "workitem.restored"}
	default:
		return nil
	}
}

func validateProviderDeclaration(t CompilerTrigger) error {
	if commandFamily(t.Event) {
		return nil
	}
	if !providerEvent(t.Event) {
		if t.Provider != "" || t.ActivityNormalization != nil || t.NativeEvents != nil {
			return ErrInvalid
		}
		if t.Event == "webhook" {
			if t.SchemaVersion != 2 || t.AnyOf != nil {
				return ErrInvalid
			}
			for _, condition := range t.Conditions {
				for _, segment := range condition.Path {
					if segment != "*" && !genericProperty.MatchString(segment) ||
						slices.Contains([]string{"__proto__", "prototype", "constructor"}, segment) {
						return ErrInvalid
					}
				}
			}
		}
		return nil
	}

	if t.SchemaVersion != 2 || t.Provider != eventProvider(t.Event) || t.ActivityNormalization == nil ||
		t.ActivityNormalization.Policy != t.Provider+"-issue/v1" || len(t.NativeEvents) == 0 ||
		len(t.NativeEvents) > 4 {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, event := range t.NativeEvents {
		if seen[event] || !slices.Contains(providerNativeEvents(t.Event), event) {
			return ErrInvalid
		}
		seen[event] = true
	}
	states := t.ActivityNormalization.ClosedStates
	if states != nil && (t.Event != "azure_devops_issue" || len(states) == 0 || len(states) > 128) {
		return ErrInvalid
	}
	seen = make(map[string]bool)
	for _, state := range states {
		if strings.TrimSpace(state) == "" || len(state) > 256 || seen[state] {
			return ErrInvalid
		}
		seen[state] = true
	}
	for _, activity := range t.Types {
		if !slices.Contains(t.NativeEvents, providerNativeForActivity(t.Event, activity)) ||
			t.Event == "azure_devops_issue" && (activity == "closed" || activity == "reopened") && len(states) == 0 {
			return ErrInvalid
		}
	}
	if t.Event == "azure_devops_issue" {
		for _, group := range compilerConditionGroups(t) {
			for _, condition := range group {
				if condition.Filter == "closed-states" {
					return ErrInvalid
				}
			}
		}
	}
	for _, condition := range t.Conditions {
		if reflect.DeepEqual(condition.Path, externalScopePath(t.Event)) && condition.ValueType == "string" {
			return nil
		}
	}
	return ErrInvalid
}

func providerNativeForActivity(event, activity string) string {
	native := providerNativeEvents(event)
	if len(native) == 0 {
		return ""
	}
	switch activity {
	case "opened":
		return native[0]
	case "deleted":
		return native[2]
	case "restored":
		if len(native) == 4 {
			return native[3]
		}
		return ""
	default:
		return native[1]
	}
}

func nativeAction(event string, root map[string]any) string {
	key := "action"
	switch event {
	case "jira_issue":
		key = "webhookEvent"
	case "azure_devops_issue":
		key = "eventType"
	case "webhook":
		key = "type"
	}
	value, _ := root[key].(string)
	if event == "linear_issue" && root["type"] != "Issue" {
		return ""
	}
	return value
}
