package webhookgateway

import (
	"bytes"
	"encoding/json"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"time"
)

// ExternalSource is reviewed receiver enrollment, never compiler metadata.
// SecretEnv names receive-only secrets; their values never enter gateway state.
type ExternalSource struct {
	ID                       string    `json:"id"`
	Event                    string    `json:"event"`
	ResourceURLPrefix        string    `json:"resourceUrlPrefix"`
	Scope                    string    `json:"scope,omitempty"`
	CollectionID             string    `json:"collectionId,omitempty"`
	Types                    []string  `json:"types,omitempty"`
	URLPath                  string    `json:"urlPath,omitempty"`
	SecretEnv                string    `json:"secretEnv"`
	DestinationRepositoryIDs []int64   `json:"destinationRepositoryIds"`
	ExpiresAt                time.Time `json:"expiresAt"`
}

func (s *ExternalSource) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return ErrInvalid
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return ErrInvalid
		}
	}
	type plain ExternalSource
	var source plain
	if strictDecode(data, &source) != nil {
		return ErrInvalid
	}
	for _, field := range []string{"scope", "collectionId", "types", "urlPath"} {
		_, present := fields[field]
		forbidden := source.Event == "webhook" && (field == "scope" || field == "collectionId") ||
			source.Event != "webhook" && (field == "types" || field == "urlPath") ||
			source.Event != "azure_devops_issue" && field == "collectionId"
		if present && forbidden {
			return ErrInvalid
		}
	}
	*s = ExternalSource(source)
	return validateExternalSource(*s)
}

var externalSecretName = regexp.MustCompile(`^CAO_GATEWAY_SOURCE_[A-Z0-9_]+$`)
var genericTypePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$`)

func genericWebhookType(value string) bool { return genericTypePattern.MatchString(value) }

func eventProvider(event string) string {
	switch event {
	case "jira_issue":
		return "jira"
	case "linear_issue":
		return "linear"
	case "azure_devops_issue":
		return "azure-devops"
	case "webhook":
		return "webhook"
	default:
		return ""
	}
}

func providerEvent(event string) bool { return event != "webhook" && eventProvider(event) != "" }

func validateExternalSource(source ExternalSource) error {
	if !identifier(source.ID) || len(source.ID) > 64 || source.ID == "." || source.ID == ".." ||
		source.ID == CompilerSourceID || eventProvider(source.Event) == "" ||
		!externalSecretName.MatchString(source.SecretEnv) || len(source.SecretEnv) > 128 || strings.HasSuffix(source.SecretEnv, "_PREVIOUS") ||
		source.ExpiresAt.IsZero() || len(source.DestinationRepositoryIDs) == 0 ||
		len(source.DestinationRepositoryIDs) > 64 || len(source.ResourceURLPrefix) > 2048 ||
		!canonicalResourceURL(source.ResourceURLPrefix) || !strings.HasSuffix(source.ResourceURLPrefix, "/") {
		return ErrInvalid
	}
	seen := make(map[int64]bool)
	for _, repository := range source.DestinationRepositoryIDs {
		if repository <= 0 || seen[repository] {
			return ErrInvalid
		}
		seen[repository] = true
	}
	if source.Event == "webhook" {
		if source.Scope != "" || source.CollectionID != "" || len(source.Types) == 0 || len(source.Types) > 128 {
			return ErrInvalid
		}
		if source.URLPath == "" || len(source.URLPath) > 256 {
			return ErrInvalid
		}
		if _, err := pointer(source.URLPath, DefaultLimits()); err != nil {
			return err
		}
		types := make(map[string]bool)
		for _, name := range source.Types {
			if !genericWebhookType(name) || types[name] {
				return ErrInvalid
			}
			types[name] = true
		}
	} else if strings.TrimSpace(source.Scope) == "" || len(source.Scope) > 256 ||
		strings.ContainsAny(source.Scope, "\r\n") || strings.ContainsAny(source.CollectionID, "\r\n") ||
		len(source.Types) != 0 || source.URLPath != "" || len(source.CollectionID) > 256 ||
		(source.Event == "azure_devops_issue") != (strings.TrimSpace(source.CollectionID) != "") {
		return ErrInvalid
	}
	if source.Event != "webhook" && !validExternalResource(source, source.ResourceURLPrefix+"1") {
		// Linear uses an issue identifier rather than an integer.
		if source.Event != "linear_issue" || !validExternalResource(source, source.ResourceURLPrefix+"APP-1") {
			return ErrInvalid
		}
	}
	return nil
}

func validateExternalSources(policy GatewayPolicy) error {
	if len(policy.ExternalSources) > 64 || len(policy.ExternalSources) > 0 && policy.Discovery == nil {
		return ErrInvalid
	}
	ids, secrets := make(map[string]bool), make(map[string]bool)
	for _, source := range policy.ExternalSources {
		if validateExternalSource(source) != nil || ids[source.ID] || secrets[source.SecretEnv] {
			return ErrInvalid
		}
		ids[source.ID], secrets[source.SecretEnv] = true, true
		for _, destination := range source.DestinationRepositoryIDs {
			if !slices.ContainsFunc(policy.Discovery.Repositories, func(repository DiscoveryRepository) bool {
				return repository.RepositoryID == destination
			}) {
				return ErrInvalid
			}
		}
	}
	return nil
}

func (p PolicySnapshot) ExternalSource(id string) (ExternalSource, bool) {
	for _, source := range p.Policy.ExternalSources {
		if source.ID == id {
			return source, true
		}
	}
	return ExternalSource{}, false
}

func ExternalSourceCurrent(p PolicySnapshot, s Subscription, now time.Time) bool {
	if s.Source.External == nil {
		return false
	}
	source, found := p.ExternalSource(s.Source.ID)
	return found && reflect.DeepEqual(source, *s.Source.External) && now.Before(source.ExpiresAt) &&
		slices.Contains(source.DestinationRepositoryIDs, s.Destination.RepositoryID)
}

func externalScopePath(event string) []string {
	switch event {
	case "jira_issue":
		return []string{"issue", "fields", "project", "key"}
	case "linear_issue":
		return []string{"organizationId"}
	case "azure_devops_issue":
		return []string{"resourceContainers", "project", "id"}
	default:
		return nil
	}
}

func externalDeclarationMatches(source ExternalSource, trigger CompilerTrigger) bool {
	if source.Event != trigger.Event || trigger.SchemaVersion != 2 {
		return false
	}
	if trigger.Event == "webhook" {
		return len(trigger.Types) == 1 && slices.Contains(source.Types, trigger.Types[0])
	}
	for _, condition := range trigger.Conditions {
		if reflect.DeepEqual(condition.Path, externalScopePath(trigger.Event)) {
			return slices.ContainsFunc(condition.Values, func(raw json.RawMessage) bool {
				var value string
				return json.Unmarshal(raw, &value) == nil && value == source.Scope
			})
		}
	}
	return false
}
