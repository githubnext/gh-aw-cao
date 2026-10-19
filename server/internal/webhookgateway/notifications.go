package webhookgateway

import (
	_ "embed"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
)

type notificationFilter struct {
	Path    []string `json:"path"`
	Type    string   `json:"type"`
	Enum    []string `json:"enum,omitempty"`
	Actions []string `json:"actions,omitempty"`
}

type notificationDefinition struct {
	Native    string                        `json:"native_event"`
	Actions   []string                      `json:"actions"`
	Path      string                        `json:"path"`
	Anchor    string                        `json:"anchor"`
	URLPath   []string                      `json:"url_path"`
	IssueKind string                        `json:"issue_kind,omitempty"`
	Filters   map[string]notificationFilter `json:"filters"`
}

type notificationCatalog struct {
	Common map[string]notificationFilter     `json:"common_filters"`
	Events map[string]notificationDefinition `json:"events"`
}

// Semantic projection of gh-aw@fe4f420f's shared catalog, excluding descriptions.
//
//go:embed notification_catalog.json
var notificationCatalogJSON []byte

var notifications = func() notificationCatalog {
	var catalog notificationCatalog
	if err := json.Unmarshal(notificationCatalogJSON, &catalog); err != nil {
		panic(err)
	}
	return catalog
}()

func notificationFamily(event string) bool {
	_, exists := notifications.Events[event]
	return exists
}

func githubHTMLFamily(event string) bool { return commandFamily(event) || notificationFamily(event) }

func validateNotificationDeclaration(t CompilerTrigger) error {
	definition := notifications.Events[t.Event]
	if t.SchemaVersion != 2 || t.Provider != "" || t.CommandFilter != nil || t.ActivityNormalization != nil ||
		t.AnyOf != nil || !slices.Equal(t.NativeEvents, []string{definition.Native}) {
		return ErrInvalid
	}
	filters := maps.Clone(notifications.Common)
	maps.Copy(filters, definition.Filters)
	seen := make(map[string]bool)
	for _, condition := range t.Conditions {
		filter, exists := filters[condition.Filter]
		if !exists || seen[condition.Filter] || !slices.Equal(condition.Path, filter.Path) || condition.ValueType != filter.Type {
			return ErrInvalid
		}
		seen[condition.Filter] = true
		for _, value := range conditionOperands(condition) {
			if text, ok := value.(string); len(filter.Enum) > 0 && (!ok || !slices.Contains(filter.Enum, text)) {
				return ErrInvalid
			}
		}
	}
	return nil
}

func notificationSourceMatches(t CompilerTrigger, native, action string, root any) bool {
	definition := notifications.Events[t.Event]
	if native != definition.Native || textAt(root, "action") != action ||
		!slices.Contains(t.Types, action) || !slices.Contains(definition.Actions, action) {
		return false
	}
	if definition.IssueKind != "" {
		issue, ok := at(root, "issue").(map[string]any)
		if !ok {
			return false
		}
		pr, exists := issue["pull_request"]
		if definition.IssueKind == "issue" && exists {
			return false
		}
		if definition.IssueKind == "pull_request" {
			if _, ok := pr.(map[string]any); !exists || !ok {
				return false
			}
		}
	}
	for _, condition := range t.Conditions {
		if filter := definition.Filters[condition.Filter]; len(filter.Actions) > 0 && !slices.Contains(filter.Actions, action) {
			return false
		}
	}
	return compilerConditionsMatch(root, t.Conditions)
}

func notificationPermissions(event string) map[string]string {
	permission := "contents"
	switch notifications.Events[event].Path {
	case "issues":
		permission = "issues"
	case "pull":
		permission = "pull_requests"
	case "discussions":
		permission = "discussions"
	}
	return map[string]string{"contents": "read", permission: "read"}
}

func notificationURLParts(s Subscription, text string) (string, string, bool) {
	definition := notifications.Events[s.Source.Event]
	return githubResourceParts(s, text, definition.Path, definition.Anchor, definition.Path == "commit")
}

func notificationOriginalURL(s Subscription, event Event, root any, l Limits) (string, error) {
	definition := notifications.Events[s.Source.Event]
	if !notificationSourceMatches(*s.Compiler, event.Name, event.Action, root) ||
		at(root, "repository", "private") != true {
		return "", ErrInvalid
	}
	value, exists := lookup(root, "/"+strings.Join(definition.URLPath, "/"), l)
	resource, ok := value.(string)
	if !exists || !ok {
		return "", ErrInvalid
	}
	repository, number, valid := notificationURLParts(s, resource)
	if !valid || !strings.EqualFold(repository, textAt(root, "repository", "full_name")) ||
		!CompilerRepositoryMatches(*s.Compiler, repository) {
		return "", ErrInvalid
	}
	parent := "pull_request"
	switch {
	case definition.IssueKind != "":
		parent = "issue"
	case definition.Path == "discussions":
		parent = "discussion"
	case definition.Path == "commit":
		if textAt(root, "comment", "commit_id") != number {
			return "", ErrInvalid
		}
	}
	if definition.Path != "commit" {
		id := at(root, parent, "number")
		if !positiveSafeInteger(id) || string(id.(json.Number)) != number {
			return "", ErrInvalid
		}
	}
	if definition.Anchor != "" {
		idPath := append(slices.Clone(definition.URLPath[:len(definition.URLPath)-1]), "id")
		id, exists := lookup(root, "/"+strings.Join(idPath, "/"), l)
		if !exists || !positiveSafeInteger(id) || !strings.HasSuffix(resource, "#"+definition.Anchor+string(id.(json.Number))) {
			return "", ErrInvalid
		}
	}
	return resource, nil
}

func buildNotificationDispatchPayload(s Subscription, event Event, root any, l Limits) (json.RawMessage, error) {
	resource, err := notificationOriginalURL(s, event, root, l)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{"url": resource, "type": []any{event.Action}}
	if addCompilerFilters(payload, *s.Compiler, root) != nil || !validNotification(s, payload, event.Action, true) {
		return nil, ErrInvalid
	}
	data, err := json.Marshal(map[string]any{"event_type": s.Destination.EventType, "client_payload": map[string]any{
		"schema_version": 1, "event": s.Source.Event, "delivery_id": event.DeliveryID, "payload": payload,
	}})
	if err != nil || len(data) > l.MaxDispatchBytes {
		return nil, ErrInvalid
	}
	return data, nil
}

func validNotification(s Subscription, payload map[string]any, action string, bind bool) bool {
	activities, ok := payload["type"].([]any)
	if !ok || len(activities) != 1 || !validCompilerFilters(*s.Compiler, payload) {
		return false
	}
	activity, ok := activities[0].(string)
	if !ok || !slices.Contains(s.Compiler.Types, activity) || bind && activity != action {
		return false
	}
	text, ok := payload["url"].(string)
	repository, _, valid := notificationURLParts(s, text)
	if !ok || !valid || !CompilerRepositoryMatches(*s.Compiler, repository) {
		return false
	}
	for _, condition := range s.Compiler.Conditions {
		filter := notifications.Events[s.Source.Event].Filters[condition.Filter]
		if len(filter.Actions) > 0 && !slices.Contains(filter.Actions, activity) {
			return false
		}
	}
	return true
}

func validResourceNumber(number string) bool {
	value, err := strconv.ParseInt(number, 10, 64)
	return err == nil && regexpDecimalID.MatchString(number) && value <= 9007199254740991
}
