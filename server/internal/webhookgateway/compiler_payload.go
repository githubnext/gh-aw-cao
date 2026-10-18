package webhookgateway

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

func validateCompilerSubscription(s Subscription, l Limits) error {
	t := s.Compiler
	id := strings.TrimSuffix(strings.TrimPrefix(t.Dispatch.Workflow, ".github/workflows/"), ".lock.yml")
	if t.SchemaVersion != 2 || !identifier(id) || t.Dispatch.Workflow != ".github/workflows/"+id+".lock.yml" ||
		s.Source.ID != CompilerSourceID || SecurityEventPermission(t.Event) == "" || t.Event != s.Source.Event ||
		s.Source.RepositoryID <= 0 || t.Repos == nil && s.Source.RepositoryID != s.Destination.RepositoryID ||
		s.Destination.Kind != "repository_dispatch" || s.Destination.EventType != t.Dispatch.EventType ||
		len(s.Destination.Fields) != 0 || len(s.Source.ProjectIDs) != 0 ||
		s.Source.RequiredPermissions[SecurityEventPermission(t.Event)] != "read" ||
		s.Source.RequiredPermissions["contents"] != "read" {
		return ErrInvalid
	}
	return validateCompilerTrigger(*t, t.Dispatch.Workflow, id, l)
}

var compilerAlertPath = regexp.MustCompile(`^/repos/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/(code-scanning|dependabot)/alerts/[1-9][0-9]*$`)

func validCompilerAlertURL(event string, value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	parsed, err := url.Parse(text)
	family := map[string]string{"dependabot_alert": "dependabot", "code_scanning_alert": "code-scanning"}[event]
	return err == nil && family != "" && parsed.Scheme == "https" && parsed.Host == "api.github.com" &&
		parsed.User == nil && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" &&
		parsed.RawPath == "" && parsed.String() == text && compilerAlertPath.MatchString(parsed.Path) &&
		strings.Contains(parsed.Path, "/"+family+"/alerts/")
}

// compilerProjection is an explicit scalar allowlist, not raw-body forwarding.
// In particular secret-scanning secret values and payload titles/bodies cannot
// enter either durable jobs or the generated workflow's inline context.
func compilerProjection(root any, l Limits) (map[string]any, error) {
	for _, path := range []string{"/repository/id", "/installation/id", "/alert/number"} {
		if value, exists := lookup(root, path, l); !exists || !positiveSafeInteger(value) {
			return nil, ErrInvalid
		}
	}
	if private, _ := lookup(root, "/repository/private", l); private != true {
		return nil, ErrUnauthorized
	}
	value, exists := lookup(root, "/alert/url", l)
	if !exists {
		return nil, ErrInvalid
	}
	return map[string]any{"url": value}, nil
}

func positiveSafeInteger(value any) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	id, err := number.Int64()
	return err == nil && id > 0 && id <= 9007199254740991
}

func buildCompilerDispatchPayload(s Subscription, event Event, root any, l Limits) (json.RawMessage, error) {
	payload, err := compilerProjection(root, l)
	if err != nil {
		return nil, err
	}
	if !validCompilerAlertURL(event.Name, payload["url"]) || !compilerTriggerAction(s.Compiler.Types, event.Action) {
		return nil, ErrInvalid
	}
	repository, _ := lookup(root, "/repository/full_name", l)
	number, _ := lookup(root, "/alert/number", l)
	family := strings.TrimSuffix(strings.ReplaceAll(event.Name, "_", "-"), "-alert")
	if repositoryName, ok := repository.(string); !ok ||
		!CompilerRepositoryMatches(*s.Compiler, repositoryName) ||
		payload["url"] != "https://api.github.com/repos/"+repositoryName+"/"+family+"/alerts/"+string(number.(json.Number)) {
		return nil, ErrInvalid
	}
	properties := map[string]any{"schema_version": 1, "event": event.Name, "delivery_id": event.DeliveryID, "payload": payload}
	data, err := json.Marshal(map[string]any{"event_type": s.Destination.EventType, "client_payload": properties})
	if err != nil || len(data) > l.MaxDispatchBytes {
		return nil, ErrInvalid
	}
	return data, nil
}

func validateCompilerProperties(job Job, properties map[string]any, l Limits, bindIdentity bool) error {
	s := job.Subscription
	for key, value := range properties {
		switch key {
		case "_gateway":
			if err := validateProvenance(job, value, l, bindIdentity); err != nil {
				return err
			}
		case "schema_version", "event", "delivery_id", "payload":
		default:
			return ErrInvalid
		}
	}
	if properties["schema_version"] != json.Number("1") || properties["event"] != s.Source.Event {
		return ErrInvalid
	}
	delivery, ok := properties["delivery_id"].(string)
	if !ok || !identifier(delivery) || bindIdentity && delivery != job.DeliveryID {
		return ErrInvalid
	}
	root, ok := properties["payload"].(map[string]any)
	if !ok {
		return ErrInvalid
	}
	if len(root) != 1 || !validCompilerAlertURL(s.Source.Event, root["url"]) {
		return ErrInvalid
	}
	if bindIdentity && !compilerTriggerAction(s.Compiler.Types, job.Event.Action) {
		return ErrInvalid
	}
	return nil
}

func compilerTriggerAction(types []string, action string) bool {
	for _, expected := range types {
		if action == expected {
			return true
		}
	}
	return false
}

// DispatchRevision binds out-of-band dispatch authority to every durable member.
// Compiler v2 forbids putting gateway provenance in its wire envelope.
func DispatchRevision(jobs []Job) (Revision, error) {
	if len(jobs) == 0 || len(jobs) > MaxDispatchBatchItems || jobs[0].Subscription.Compiler == nil {
		return Revision{}, ErrInvalid
	}
	var revision Revision
	for _, job := range jobs {
		var request struct {
			ClientPayload struct {
				Gateway dispatchProvenance `json:"_gateway"`
			} `json:"client_payload"`
		}
		if !BatchCompatible(jobs[0], job) || ValidateJob(job) != nil ||
			json.Unmarshal(job.Payload, &request) != nil || !validRevision(request.ClientPayload.Gateway.Revision) ||
			revision != (Revision{}) && revision != request.ClientPayload.Gateway.Revision {
			return Revision{}, ErrInvalid
		}
		revision = request.ClientPayload.Gateway.Revision
	}
	return revision, nil
}

func ValidateCompilerRevision(s Subscription, revision Revision) error {
	if s.Compiler == nil || !validRevision(revision) || revision.RepositoryID != s.Destination.RepositoryID ||
		revision.MetadataPath != s.Compiler.Dispatch.Workflow {
		return ErrInvalid
	}
	return nil
}
