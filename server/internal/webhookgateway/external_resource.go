package webhookgateway

import (
	"encoding/json"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
)

var jiraResourcePath = regexp.MustCompile(`^/rest/api/[23]/issue/([1-9][0-9]*)$`)
var linearResourcePath = regexp.MustCompile(`^/[a-zA-Z0-9_-]+/issue/[A-Z][A-Z0-9_-]*-[1-9][0-9]*(/([a-zA-Z0-9_-]|%[0-9a-fA-F]{2})+)?$`)
var azureResourcePath = regexp.MustCompile(`^/[a-zA-Z0-9_-]+(/([a-zA-Z0-9_.-]|%[0-9a-fA-F]{2})+)?/_apis/wit/work[Ii]tems/[1-9][0-9]*$`)
var azureResourceHost = regexp.MustCompile(`^[a-zA-Z0-9-]+\.visualstudio\.com$`)

func canonicalResourceURL(text string) bool {
	parsed, err := url.Parse(text)
	if err != nil || len(text) > 4096 || parsed.Scheme != "https" || parsed.Hostname() == "" ||
		parsed.Host != strings.ToLower(parsed.Host) || parsed.Port() == "443" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
		strings.ContainsAny(text, "\\ \t\r\n#?") || parsed.String() != text {
		return false
	}
	cleaned := path.Clean(parsed.Path)
	return parsed.Path == cleaned || strings.HasSuffix(parsed.Path, "/") && strings.TrimSuffix(parsed.Path, "/") == cleaned
}

func validExternalResource(source ExternalSource, text string) bool {
	if !canonicalResourceURL(text) || !strings.HasPrefix(text, source.ResourceURLPrefix) {
		return false
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return false
	}
	switch source.Event {
	case "jira_issue":
		return jiraResourcePath.MatchString(parsed.EscapedPath())
	case "linear_issue":
		return parsed.Host == "linear.app" && linearResourcePath.MatchString(parsed.EscapedPath()) &&
			!strings.HasPrefix(parsed.Path, "/issue/")
	case "azure_devops_issue":
		return (parsed.Host == "dev.azure.com" || azureResourceHost.MatchString(parsed.Host)) &&
			azureResourcePath.MatchString(parsed.EscapedPath())
	case "webhook":
		return true
	default:
		return false
	}
}

func at(root any, keys ...string) any {
	for _, key := range keys {
		object, ok := root.(map[string]any)
		if !ok {
			return nil
		}
		root = object[key]
	}
	return root
}

func textAt(root any, keys ...string) string {
	value, _ := at(root, keys...).(string)
	return value
}

func externalResource(source ExternalSource, root any, l Limits) (string, error) {
	if source.Event != "webhook" && textAt(root, externalScopePath(source.Event)...) != source.Scope {
		return "", ErrUnauthorized
	}
	var resource string
	switch source.Event {
	case "jira_issue":
		id := textAt(root, "issue", "id")
		if !regexpDecimalID.MatchString(id) {
			return "", ErrInvalid
		}
		resource = textAt(root, "issue", "self")
		if resource != source.ResourceURLPrefix+id {
			return "", ErrUnauthorized
		}
	case "linear_issue":
		if strings.TrimSpace(textAt(root, "data", "id")) == "" {
			return "", ErrInvalid
		}
		resource = textAt(root, "data", "url")
	case "azure_devops_issue":
		if textAt(root, "resourceContainers", "collection", "id") != source.CollectionID {
			return "", ErrUnauthorized
		}
		id := at(root, "resource", "workItemId")
		if id == nil && (textAt(root, "eventType") != "workitem.updated" ||
			textAt(root, "resourceVersion") == "1.0" && at(root, "resource", "revision") == nil) {
			id = at(root, "resource", "id")
		}
		if !positiveSafeInteger(id) {
			return "", ErrInvalid
		}
		resource = source.ResourceURLPrefix + string(id.(json.Number))
	case "webhook":
		value, found := lookup(root, source.URLPath, l)
		if !found {
			return "", ErrInvalid
		}
		resource, _ = value.(string)
	default:
		return "", ErrInvalid
	}
	if !validExternalResource(source, resource) {
		return "", ErrUnauthorized
	}
	return resource, nil
}

var regexpDecimalID = regexp.MustCompile(`^[1-9][0-9]*$`)

func parseExternalEvent(source ExternalSource, delivery string, payload []byte, limits Limits) (Event, error) {
	l, err := resolveLimits(limits)
	if err != nil || !identifier(delivery) || validateExternalSource(source) != nil {
		return Event{}, ErrInvalid
	}
	root, err := boundedJSON(payload, l.MaxEventBytes, l)
	object, ok := root.(map[string]any)
	if err != nil || !ok {
		return Event{}, ErrInvalid
	}
	action := nativeAction(source.Event, object)
	if source.Event == "webhook" {
		if !slices.Contains(source.Types, action) {
			return Event{}, ErrUnauthorized
		}
	} else if !slices.Contains(providerNativeEvents(source.Event), action) {
		return Event{}, ErrInvalid
	}
	if _, err := externalResource(source, root, l); err != nil {
		return Event{}, err
	}
	return Event{SourceID: source.ID, DeliveryID: delivery, Name: source.Event, Action: action,
		Payload: append(json.RawMessage(nil), payload...)}, nil
}

func subscriptionIdentity(s Subscription, event Event) (EventIdentity, error) {
	identity := IdentityOf(event)
	if s.Compiler != nil && commandFamily(s.Source.Event) {
		root, err := boundedJSON(event.Payload, DefaultLimits().MaxEventBytes, DefaultLimits())
		if err != nil {
			return EventIdentity{}, err
		}
		semantic, _, matched := commandMatch(*s.Compiler, event.Name, root)
		if !matched {
			return EventIdentity{}, ErrInvalid
		}
		identity.Name, identity.CommandEvent = s.Source.Event, semantic
		return identity, nil
	}
	if s.Source.External == nil {
		return identity, nil
	}
	root, err := boundedJSON(event.Payload, DefaultLimits().MaxEventBytes, DefaultLimits())
	if err != nil {
		return EventIdentity{}, err
	}
	if providerEvent(event.Name) {
		identity.Activities = selectedProviderActivities(*s.Compiler, root)
	} else {
		identity.Activities = []string{event.Action}
	}
	return identity, nil
}
