package webhookgateway

import (
	"encoding/hex"
	"encoding/json"
	"net/url"
	"path"
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

func canonicalResourceURL(value any) bool {
	text, ok := value.(string)
	if !ok || len(text) == 0 || len(text) > 2048 || strings.ContainsAny(text, "\\ \t\r\n\x00") {
		return false
	}
	u, err := url.Parse(text)
	return err == nil && u.Scheme == "https" &&
		(u.Host == "api.github.com" || u.Host == "github.com") &&
		u.User == nil && u.Opaque == "" && u.RawQuery == "" && !u.ForceQuery &&
		u.Fragment == "" && u.RawFragment == "" && !strings.Contains(text, "#") &&
		!strings.ContainsAny(u.Path, "\\%") &&
		strings.IndexFunc(u.Path, func(r rune) bool { return r <= ' ' || r == '\x7f' }) < 0 &&
		u.RawPath == "" && u.Path != "" && u.Path != "/" && path.Clean(u.Path) == u.Path &&
		u.String() == text
}

func validateCompiledPayload(job Job) error {
	return validateRequest(job, DefaultLimits())
}

// ValidateDispatchPayload validates the complete API request, never a properties-only object.
// It binds selectors to approved metadata and rejects anything except one canonical URL.
func ValidateDispatchPayload(s Subscription, payload json.RawMessage, limits Limits) error {
	if err := ValidateSubscription(s, limits); err != nil {
		return err
	}
	resolved, err := resolveLimits(limits)
	if err != nil {
		return err
	}
	return validateRequest(Job{Subscription: s, Payload: payload}, resolved)
}

func validateRequest(job Job, limits Limits) error {
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
	if !ok || len(properties) != 1 || !canonicalResourceURL(properties["url"]) {
		return ErrInvalid
	}
	return nil
}
