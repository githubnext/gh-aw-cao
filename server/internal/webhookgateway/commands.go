package webhookgateway

import (
	"bytes"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

type CommandFilter struct {
	Policy      string   `json:"policy"`
	Names       []string `json:"names"`
	Events      []string `json:"events"`
	Strategy    string   `json:"strategy"`
	RemoveLabel *bool    `json:"remove_label,omitempty"`
}

func (c *CommandFilter) UnmarshalJSON(data []byte) error {
	type wire CommandFilter
	var value wire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return ErrInvalid
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return ErrInvalid
	}
	if raw, exists := fields["remove_label"]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return ErrInvalid
	}
	*c = CommandFilter(value)
	return nil
}

type commandEvent struct {
	native, item, kind, anchor, permission string
	actions                                []string
}

var commandEvents = map[string]commandEvent{
	"issues":                      {"issues", "issue", "issues", "", "issues", []string{"opened", "edited", "reopened"}},
	"issue_comment":               {"issue_comment", "issue", "issues", "issuecomment-", "issues", []string{"created", "edited"}},
	"pull_request_comment":        {"issue_comment", "issue", "pull", "issuecomment-", "pull_requests", []string{"created", "edited"}},
	"pull_request":                {"pull_request", "pull_request", "pull", "", "pull_requests", []string{"opened", "edited", "reopened"}},
	"pull_request_review_comment": {"pull_request_review_comment", "pull_request", "pull", "discussion_r", "pull_requests", []string{"created", "edited"}},
	"discussion":                  {"discussion", "discussion", "discussions", "", "discussions", []string{"created", "edited"}},
	"discussion_comment":          {"discussion_comment", "discussion", "discussions", "discussioncomment-", "discussions", []string{"created", "edited"}},
}

func commandFamily(event string) bool { return event == "slash_command" || event == "label_command" }

var commandToken = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*`)
var commandPattern = regexp.MustCompile(`^(\*|[^/*][^/*]*\*?)$`)
var githubServerOrigin = regexp.MustCompile(`^https://[a-z0-9.-]+(:[1-9][0-9]*)?(/[a-zA-Z0-9._~%+-]+)*$`)

func commandWhitespace(r rune) bool {
	return r >= '\t' && r <= '\r' || r == ' ' || r == '\u00a0' || r == '\u1680' ||
		r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' ||
		r == '\u202f' || r == '\u205f' || r == '\u3000' || r == '\ufeff'
}

func slashToken(text string) string {
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	token := commandToken.FindString(text[1:])
	if token == "" {
		return ""
	}
	if len(text) > len(token)+1 {
		next, _ := utf8.DecodeRuneInString(text[len(token)+1:])
		if !commandWhitespace(next) {
			return ""
		}
	}
	return token
}

func matchesCommandName(pattern, token string) bool {
	if token == "" {
		return false
	}
	return pattern == "*" || pattern == token ||
		strings.HasSuffix(pattern, "*") && strings.HasPrefix(token, strings.TrimSuffix(pattern, "*"))
}

func validateCommandDeclaration(t CompilerTrigger, l Limits) error {
	if !commandFamily(t.Event) {
		if t.CommandFilter != nil {
			return ErrInvalid
		}
		return nil
	}
	c := t.CommandFilter
	maxNames, alternate := 25, "centralized"
	if t.Event == "label_command" {
		maxNames, alternate = 50, "decentralized"
	}
	if t.SchemaVersion != 2 || c == nil || c.Policy != strings.ReplaceAll(t.Event, "_", "-")+"/v1" ||
		t.Provider != "" || t.ActivityNormalization != nil || len(t.Conditions) != 0 || t.AnyOf != nil ||
		len(c.Names) == 0 || len(c.Names) > min(maxNames, l.MaxArrayItems) || len(c.Events) == 0 || len(c.Events) > len(commandEvents) ||
		!slices.Contains([]string{"inline", alternate}, c.Strategy) ||
		(t.Event == "label_command") != (c.RemoveLabel != nil) {
		return ErrInvalid
	}
	if !slices.IsSorted(c.Names) || !slices.IsSorted(c.Events) || !slices.IsSorted(t.NativeEvents) {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, name := range c.Names {
		if strings.TrimFunc(name, commandWhitespace) == "" || seen[name] {
			return ErrInvalid
		}
		if t.Event == "slash_command" && !commandPattern.MatchString(name) || strings.Contains(name, "${{") {
			return ErrInvalid
		}
		seen[name] = true
	}
	native, activities := make(map[string]bool), make(map[string]bool)
	seen = make(map[string]bool)
	for _, event := range c.Events {
		definition, ok := commandEvents[event]
		if !ok || seen[event] || t.Event == "label_command" && definition.anchor != "" {
			return ErrInvalid
		}
		seen[event], native[definition.native] = true, true
		if t.Event == "label_command" {
			activities["labeled"] = true
		} else {
			for _, action := range definition.actions {
				activities[action] = true
			}
		}
	}
	if len(native) != len(t.NativeEvents) || len(activities) != len(t.Types) {
		return ErrInvalid
	}
	for _, event := range t.NativeEvents {
		if !native[event] {
			return ErrInvalid
		}
		delete(native, event)
	}
	for _, action := range t.Types {
		if !activities[action] {
			return ErrInvalid
		}
		delete(activities, action)
	}
	return nil
}

func commandAction(t CompilerTrigger, semantic, action string) bool {
	definition, ok := commandEvents[semantic]
	if !ok || t.CommandFilter == nil || !slices.Contains(t.CommandFilter.Events, semantic) ||
		!slices.Contains(t.Types, action) {
		return false
	}
	if t.Event == "label_command" {
		return definition.anchor == "" && action == "labeled"
	}
	return t.Event == "slash_command" && slices.Contains(definition.actions, action)
}

func commandMatch(t CompilerTrigger, native string, root any) (semantic, literal string, matched bool) {
	if t.CommandFilter == nil {
		return "", "", false
	}
	for _, event := range t.CommandFilter.Events {
		definition := commandEvents[event]
		if definition.native != native || !commandAction(t, event, textAt(root, "action")) {
			continue
		}
		if native == "issue_comment" {
			pr := at(root, "issue", "pull_request") != nil
			if pr != (event == "pull_request_comment") {
				continue
			}
		}
		if t.Event == "label_command" {
			name := textAt(root, "label", "name")
			if slices.Contains(t.CommandFilter.Names, name) {
				return event, name, true
			}
			continue
		}
		item := definition.item
		if definition.anchor != "" {
			item = "comment"
		}
		token := slashToken(textAt(root, item, "body"))
		if slices.ContainsFunc(t.CommandFilter.Names, func(pattern string) bool { return matchesCommandName(pattern, token) }) {
			return event, token, true
		}
	}
	return "", "", false
}

func validGitHubServerURL(origin string) bool {
	parsed, err := url.Parse(origin)
	resource := origin
	if err == nil && parsed.Path == "" {
		resource += "/"
	}
	if err != nil || !githubServerOrigin.MatchString(origin) || !canonicalResourceURL(resource) ||
		parsed.RawPath != "" || strings.HasSuffix(origin, "/") {
		return false
	}
	if parsed.Port() != "" {
		port, err := strconv.Atoi(parsed.Port())
		return err == nil && port > 0 && port <= 65535
	}
	return true
}

func commandURLParts(s Subscription, text, semantic string) (string, string, bool) {
	definition, ok := commandEvents[semantic]
	if !ok || !validGitHubServerURL(s.Source.ServerURL) {
		return "", "", false
	}
	parsed, err := url.Parse(text)
	base, baseErr := url.Parse(s.Source.ServerURL)
	if err != nil || parsed.User != nil || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		baseErr != nil || parsed.Scheme != base.Scheme || parsed.Host != base.Host ||
		!strings.HasPrefix(parsed.Path, base.Path+"/") || parsed.String() != text {
		return "", "", false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, base.Path+"/"), "/")
	if len(parts) != 4 || !RepositoryNameOK(parts[0]+"/"+parts[1]) || parts[2] != definition.kind ||
		!regexpDecimalID.MatchString(parts[3]) {
		return "", "", false
	}
	number, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || number > 9007199254740991 {
		return "", "", false
	}
	if definition.anchor == "" {
		if parsed.Fragment != "" || strings.Contains(text, "#") {
			return "", "", false
		}
	} else if !strings.HasPrefix(parsed.Fragment, definition.anchor) ||
		!regexpDecimalID.MatchString(strings.TrimPrefix(parsed.Fragment, definition.anchor)) ||
		parsed.RawFragment != "" {
		return "", "", false
	}
	if definition.anchor != "" {
		id, err := strconv.ParseInt(strings.TrimPrefix(parsed.Fragment, definition.anchor), 10, 64)
		if err != nil || id > 9007199254740991 {
			return "", "", false
		}
	}
	return parts[0] + "/" + parts[1], parts[3], true
}

func buildCommandDispatchPayload(s Subscription, event Event, root any, l Limits) (json.RawMessage, error) {
	semantic, literal, matched := commandMatch(*s.Compiler, event.Name, root)
	if !matched || at(root, "repository", "private") != true {
		return nil, ErrInvalid
	}
	definition := commandEvents[semantic]
	item := definition.item
	if definition.anchor != "" {
		item = "comment"
	}
	resource := textAt(root, item, "html_url")
	repository, number, valid := commandURLParts(s, resource, semantic)
	if !valid || !strings.EqualFold(repository, textAt(root, "repository", "full_name")) ||
		!CompilerRepositoryMatches(*s.Compiler, repository) ||
		!positiveSafeInteger(at(root, definition.item, "number")) ||
		string(at(root, definition.item, "number").(json.Number)) != number {
		return nil, ErrInvalid
	}
	if definition.anchor != "" {
		id := at(root, "comment", "id")
		if !positiveSafeInteger(id) || !strings.HasSuffix(resource, "#"+definition.anchor+string(id.(json.Number))) {
			return nil, ErrInvalid
		}
	}
	key := "command"
	if s.Compiler.Event == "label_command" {
		key = "label"
	}
	payload := map[string]any{"url": resource, "type": []any{event.Action},
		"filters": map[string]any{"event": []any{semantic}, key: []any{literal}}}
	if !validCommandNotification(s, payload, event.Action, semantic, true) {
		return nil, ErrInvalid
	}
	properties := map[string]any{"schema_version": 1, "event": s.Source.Event, "delivery_id": event.DeliveryID, "payload": payload}
	data, err := json.Marshal(map[string]any{"event_type": s.Destination.EventType, "client_payload": properties})
	if err != nil || len(data) > l.MaxDispatchBytes {
		return nil, ErrInvalid
	}
	return data, nil
}

func validCommandNotification(s Subscription, payload map[string]any, action, semantic string, bind bool) bool {
	if len(payload) != 3 {
		return false
	}
	filters, ok := payload["filters"].(map[string]any)
	if !ok || len(filters) != 2 {
		return false
	}
	single := func(value any) string {
		items, ok := value.([]any)
		if !ok || len(items) != 1 {
			return ""
		}
		text, _ := items[0].(string)
		return text
	}
	event := single(filters["event"])
	activity := single(payload["type"])
	if !commandAction(*s.Compiler, event, activity) || bind && (activity != action || semantic != "" && event != semantic) {
		return false
	}
	text, _ := payload["url"].(string)
	repository, _, valid := commandURLParts(s, text, event)
	if !valid || !CompilerRepositoryMatches(*s.Compiler, repository) {
		return false
	}
	if s.Compiler.Event == "label_command" {
		return slices.Contains(s.Compiler.CommandFilter.Names, single(filters["label"]))
	}
	token := single(filters["command"])
	return slashToken("/"+token) == token && slices.ContainsFunc(s.Compiler.CommandFilter.Names,
		func(pattern string) bool { return matchesCommandName(pattern, token) })
}

func commandPermissions(t CompilerTrigger) map[string]string {
	permissions := map[string]string{"contents": "read"}
	for _, event := range t.CommandFilter.Events {
		level := "read"
		if t.CommandFilter.RemoveLabel != nil && *t.CommandFilter.RemoveLabel {
			level = "write"
		}
		permissions[commandEvents[event].permission] = level
	}
	return permissions
}

func RequiresLabelRemoval(s Subscription) bool {
	return s.Compiler != nil && s.Source.Event == "label_command" && s.Compiler.CommandFilter != nil &&
		s.Compiler.CommandFilter.RemoveLabel != nil && *s.Compiler.CommandFilter.RemoveLabel
}

type LabelRemoval struct {
	Repository string
	Number     int64
	Label      string
	URL        string
	Event      string
}

// JobLabelRemoval derives a write target only from an admitted, validated command
// notification. It never accepts a separate caller-supplied write destination.
func JobLabelRemoval(job Job) (LabelRemoval, error) {
	if !RequiresLabelRemoval(job.Subscription) || ValidateJob(job) != nil {
		return LabelRemoval{}, ErrInvalid
	}
	root, err := boundedJSON(job.Payload, DefaultLimits().MaxDispatchBytes, DefaultLimits())
	if err != nil {
		return LabelRemoval{}, err
	}
	resource := textAt(root, "client_payload", "payload", "url")
	repository, number, valid := commandURLParts(job.Subscription, resource, job.Event.CommandEvent)
	labels, ok := at(root, "client_payload", "payload", "filters", "label").([]any)
	if !valid || !ok || len(labels) != 1 {
		return LabelRemoval{}, ErrInvalid
	}
	label, ok := labels[0].(string)
	id, err := strconv.ParseInt(number, 10, 64)
	if !ok || err != nil || !slices.Contains(job.Subscription.Compiler.CommandFilter.Names, label) {
		return LabelRemoval{}, ErrInvalid
	}
	return LabelRemoval{Repository: repository, Number: id, Label: label, URL: resource, Event: job.Event.CommandEvent}, nil
}
