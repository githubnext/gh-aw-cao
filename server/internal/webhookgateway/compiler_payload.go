package webhookgateway

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
)

func validateCompilerSubscription(s Subscription, l Limits) error {
	t := s.Compiler
	id := strings.TrimSuffix(strings.TrimPrefix(t.Dispatch.Workflow, ".github/workflows/"), ".lock.yml")
	if !identifier(id) || t.Dispatch.Workflow != ".github/workflows/"+id+".lock.yml" ||
		s.Source.ID != CompilerSourceID || SecurityEventPermission(t.Event) == "" || t.Event != s.Source.Event ||
		s.Source.RepositoryID <= 0 || s.Source.RepositoryID != s.Destination.RepositoryID ||
		s.Destination.Kind != "repository_dispatch" || s.Destination.EventType != t.Dispatch.EventType ||
		len(s.Destination.Fields) != 0 || len(s.Source.ProjectIDs) != 0 ||
		s.Source.RequiredPermissions[SecurityEventPermission(t.Event)] != "read" ||
		s.Source.RequiredPermissions["contents"] != "read" {
		return ErrInvalid
	}
	return validateCompilerTrigger(*t, t.Dispatch.Workflow, id, l)
}

var compilerProjectionPaths = []string{
	"/action", "/repository/id", "/repository/private", "/repository/visibility",
	"/installation/id", "/organization/id", "/alert/number", "/alert/state",
	"/alert/security_advisory/severity", "/alert/rule/severity", "/alert/rule/id",
	"/alert/secret_type", "/alert/resolution",
}

// compilerProjection is an explicit scalar allowlist, not raw-body forwarding.
// In particular secret-scanning secret values and payload titles/bodies cannot
// enter either durable jobs or the generated workflow's inline context.
func compilerProjection(root any, l Limits) (map[string]any, error) {
	result := make(map[string]any)
	for _, path := range compilerProjectionPaths {
		value, exists := lookup(root, path, l)
		if !exists || value == nil {
			continue
		}
		if !scalar(value) {
			return nil, ErrInvalid
		}
		switch path {
		case "/repository/id", "/installation/id", "/organization/id", "/alert/number":
			if !positiveSafeInteger(value) {
				return nil, ErrInvalid
			}
		case "/repository/private":
			if value != true {
				return nil, ErrUnauthorized
			}
		default:
			if _, ok := value.(string); !ok || path == "/repository/visibility" && value != "private" {
				return nil, ErrInvalid
			}
		}
		parts, _ := pointer(path, l)
		parent := result
		for _, part := range parts[:len(parts)-1] {
			if parent[part] == nil {
				parent[part] = make(map[string]any)
			}
			parent = parent[part].(map[string]any)
		}
		parent[parts[len(parts)-1]] = value
	}
	for _, path := range []string{"/action", "/repository/id", "/repository/private", "/installation/id", "/alert/number"} {
		if _, exists := lookup(result, path, l); !exists {
			return nil, ErrInvalid
		}
	}
	return result, nil
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
	properties := map[string]any{"schema_version": 1, "event": event.Name, "delivery_id": event.DeliveryID, "payload": payload}
	data, err := json.Marshal(map[string]any{"event_type": s.Destination.EventType, "client_payload": properties})
	if err != nil || !compilerPayloadFits(s, data, properties, l) {
		return nil, ErrInvalid
	}
	return data, nil
}

func compilerPayloadFits(s Subscription, data []byte, properties any, l Limits) bool {
	encoded, err := json.Marshal(properties)
	return err == nil && len(data) <= l.MaxDispatchBytes && len(data) <= s.Compiler.Dispatch.MaxRequestBytes &&
		len(encoded) <= s.Compiler.Dispatch.MaxPayloadBytes
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
	projected, err := compilerProjection(root, l)
	if err != nil || !reflect.DeepEqual(projected, root) {
		return ErrInvalid
	}
	action, ok := root["action"].(string)
	if !ok || !compilerTriggerAction(s.Compiler.Types, action) || bindIdentity && action != job.Event.Action {
		return ErrInvalid
	}
	repository, _ := lookup(root, "/repository/id", l)
	if repository != json.Number(strconv.FormatInt(s.Source.RepositoryID, 10)) {
		return ErrInvalid
	}
	installation, _ := lookup(root, "/installation/id", l)
	if installation != json.Number(strconv.FormatInt(s.Source.InstallationID, 10)) {
		return ErrInvalid
	}
	if s.Source.OrganizationID > 0 {
		organization, _ := lookup(root, "/organization/id", l)
		if organization != json.Number(strconv.FormatInt(s.Source.OrganizationID, 10)) {
			return ErrInvalid
		}
	}
	if !compilerPayloadFits(s, job.Payload, properties, l) {
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

// DispatchRevision reads only the runtime-owned reserved provenance.
func DispatchRevision(s Subscription, payload json.RawMessage) (Revision, error) {
	if s.Compiler == nil || ValidateDispatchPayload(s, payload, DefaultLimits()) != nil {
		return Revision{}, ErrInvalid
	}
	var request struct {
		ClientPayload struct {
			Gateway dispatchProvenance `json:"_gateway"`
		} `json:"client_payload"`
	}
	if json.Unmarshal(payload, &request) != nil || !validRevision(request.ClientPayload.Gateway.Revision) {
		return Revision{}, ErrInvalid
	}
	return request.ClientPayload.Gateway.Revision, nil
}
