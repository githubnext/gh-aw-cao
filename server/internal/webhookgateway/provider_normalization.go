package webhookgateway

import (
	"maps"
	"slices"
	"strings"
	"time"
)

func providerActivities(trigger CompilerTrigger, root any) []string {
	object, ok := root.(map[string]any)
	if !ok {
		return nil
	}
	native := nativeAction(trigger.Event, object)
	natives := providerNativeEvents(trigger.Event)
	if !slices.Contains(natives, native) {
		return nil
	}
	switch native {
	case natives[0]:
		return []string{"opened"}
	case natives[2]:
		return []string{"deleted"}
	case "workitem.restored":
		return []string{"restored"}
	}
	activities := []string{"edited"}
	switch trigger.Event {
	case "jira_issue":
		changes, _ := at(root, "changelog", "items").([]any)
		for _, change := range changes {
			object, ok := change.(map[string]any)
			if !ok || object["fieldtype"] != "jira" {
				continue
			}
			switch object["field"] {
			case "resolution":
				before, hasBefore := object["from"]
				after, hasAfter := object["to"]
				if hasBefore && hasAfter {
					if before == nil && nonemptyText(after) {
						activities = append(activities, "closed")
					}
					if nonemptyText(before) && after == nil {
						activities = append(activities, "reopened")
					}
				}
			case "labels":
				labels, ok := stringArray(at(root, "issue", "fields", "labels"))
				if !ok {
					continue
				}
				before, hasBefore := object["fromString"]
				after, hasAfter := object["toString"]
				if hasBefore && before == nil && nonemptyText(after) && len(labels) == 1 && labels[0] == after {
					activities = append(activities, "labeled")
				}
				if nonemptyText(before) && hasAfter && after == nil && len(labels) == 0 {
					activities = append(activities, "unlabeled")
				}
			}
		}
	case "linear_issue":
		before, beforeOK := at(root, "updatedFrom").(map[string]any)
		after, afterOK := at(root, "data").(map[string]any)
		if !beforeOK || !afterOK {
			break
		}
		_, completed := before["completedAt"]
		_, canceled := before["canceledAt"]
		if completed || canceled {
			prior := maps.Clone(after)
			maps.Copy(prior, before)
			wasClosed, isClosed := terminalIssue(prior), terminalIssue(after)
			if wasClosed == 0 && isClosed == 1 {
				activities = append(activities, "closed")
			}
			if wasClosed == 1 && isClosed == 0 {
				activities = append(activities, "reopened")
			}
		}
		activities = appendLabelActivities(activities, before["labelIds"], after["labelIds"])
	case "azure_devops_issue":
		before, beforeOK := at(root, "resource", "fields", "System.State", "oldValue").(string)
		after, afterOK := at(root, "resource", "fields", "System.State", "newValue").(string)
		if beforeOK && afterOK && strings.TrimSpace(before) != "" && strings.TrimSpace(after) != "" {
			states := trigger.ActivityNormalization.ClosedStates
			if !slices.Contains(states, before) && slices.Contains(states, after) {
				activities = append(activities, "closed")
			}
			if slices.Contains(states, before) && !slices.Contains(states, after) {
				activities = append(activities, "reopened")
			}
		}
		oldTags, oldOK := at(root, "resource", "fields", "System.Tags", "oldValue").(string)
		newTags, newOK := at(root, "resource", "fields", "System.Tags", "newValue").(string)
		if oldOK && newOK {
			activities = appendLabelActivities(activities, splitTags(oldTags), splitTags(newTags))
		}
	}
	slices.Sort(activities)
	return slices.Compact(activities)
}

func nonemptyText(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

func stringArray(value any) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, false
		}
		result = append(result, text)
	}
	return result, true
}

func appendLabelActivities(activities []string, before, after any) []string {
	prior, priorOK := stringArray(before)
	current, currentOK := stringArray(after)
	if !priorOK || !currentOK {
		return activities
	}
	if slices.ContainsFunc(current, func(label string) bool { return !slices.Contains(prior, label) }) {
		activities = append(activities, "labeled")
	}
	if slices.ContainsFunc(prior, func(label string) bool { return !slices.Contains(current, label) }) {
		activities = append(activities, "unlabeled")
	}
	return activities
}

func splitTags(value string) []any {
	result := make([]any, 0)
	for _, tag := range strings.Split(value, ";") {
		if tag = strings.TrimSpace(tag); tag != "" {
			result = append(result, tag)
		}
	}
	return result
}

func terminalIssue(value map[string]any) int {
	knownOpen := true
	for _, field := range []string{"completedAt", "canceledAt"} {
		raw, exists := value[field]
		if text, ok := raw.(string); ok {
			if _, err := time.Parse(time.RFC3339Nano, text); err == nil {
				return 1
			}
		}
		knownOpen = knownOpen && exists && raw == nil
	}
	if knownOpen {
		return 0
	}
	return -1
}
