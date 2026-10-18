package webhookgateway

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
)

const MaxWorkflowArtifactBytes = 8 << 20
const compilerProjectionPolicy = "resource-url-types/v1"

// CompilerCondition preserves gh-aw's typed equality and array traversal paths.
type CompilerCondition struct {
	Filter    string            `json:"filter"`
	Path      []string          `json:"path"`
	Operator  string            `json:"operator"`
	ValueType string            `json:"value_type"`
	Values    []json.RawMessage `json:"values"`
}

type CompilerContext struct {
	Envelope   string `json:"envelope"`
	AWContext  string `json:"aw_context,omitempty"`
	Event      string `json:"event"`
	Payload    string `json:"payload,omitempty"`
	DeliveryID string `json:"delivery_id,omitempty"`
	Deliveries string `json:"deliveries,omitempty"`
	Items      string `json:"items,omitempty"`
}

type CompilerBatch struct {
	Mode          string `json:"mode"`
	DeduplicateBy string `json:"deduplicate_by"`
}

type CompilerProjection struct {
	Policy string `json:"policy"`
}

type CompilerDispatch struct {
	Repository        string              `json:"repository"`
	Method            string              `json:"method"`
	EventType         string              `json:"event_type"`
	Workflow          string              `json:"workflow"`
	Context           CompilerContext     `json:"context"`
	Batch             *CompilerBatch      `json:"batch,omitempty"`
	PayloadProjection *CompilerProjection `json:"payload_projection,omitempty"`
	MaxPayloadBytes   int                 `json:"max_payload_bytes"`
	MaxRequestBytes   int                 `json:"max_request_bytes"`
}

// CompilerTrigger is the numeric-versioned discovery contract emitted by gh-aw,
// not the separately approved Subscription or a grant of dispatch authority.
type CompilerTrigger struct {
	SchemaVersion int                   `json:"schema_version"`
	Event         string                `json:"event"`
	Repos         []string              `json:"repos,omitempty"`
	Types         []string              `json:"types"`
	Conditions    []CompilerCondition   `json:"conditions"`
	AnyOf         [][]CompilerCondition `json:"any_of,omitempty"`
	Dispatch      CompilerDispatch      `json:"dispatch"`
}

type WorkflowTrigger struct {
	ArtifactSHA256  string          `json:"artifactSha256"`
	ManifestVersion int             `json:"manifestVersion"`
	Declaration     CompilerTrigger `json:"declaration"`
}

// TriggerMapping is an event-to-workflow discovery index. Even a matching entry
// still needs independent immutable-identity, projection, and revision approval.
type TriggerMapping struct {
	SchemaVersion string                       `json:"schemaVersion"`
	DiscoveryOnly bool                         `json:"discoveryOnly"`
	ByEvent       map[string][]WorkflowTrigger `json:"byEvent"`
	metadataBytes int
}

func NewTriggerMapping() TriggerMapping {
	return TriggerMapping{SchemaVersion: "cao.webhook-trigger-mapping/v1", DiscoveryOnly: true,
		ByEvent: make(map[string][]WorkflowTrigger)}
}

// ParseWorkflowManifest reads only the single-line header, never YAML steps or
// source frontmatter. The digest binds the entire compiled lock file.
func ParseWorkflowManifest(data []byte, workflow string, limits Limits) ([]WorkflowTrigger, error) {
	l, err := resolveLimits(limits)
	if err != nil || len(data) == 0 || len(data) > MaxWorkflowArtifactBytes {
		return nil, ErrInvalid
	}
	id := strings.TrimSuffix(strings.TrimPrefix(workflow, ".github/workflows/"), ".lock.yml")
	if !identifier(id) || id == "." || id == ".." || workflow != ".github/workflows/"+id+".lock.yml" {
		return nil, ErrInvalid
	}
	var header []byte
	preamble := true
	for line := range bytes.SplitSeq(data, []byte("\n")) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		if bytes.HasPrefix(line, []byte("# gh-aw-manifest:")) {
			if !preamble || header != nil || !bytes.HasPrefix(line, []byte("# gh-aw-manifest: ")) {
				return nil, ErrInvalid
			}
			header = bytes.TrimPrefix(line, []byte("# gh-aw-manifest: "))
		}
		if len(bytes.TrimSpace(line)) > 0 && !bytes.HasPrefix(line, []byte("#")) {
			preamble = false
		}
	}
	tree, err := boundedJSON(header, l.MaxMetadataBytes, l)
	object, ok := tree.(map[string]any)
	if err != nil || !ok || object["version"] != json.Number("1") {
		return nil, ErrInvalid
	}
	raw, exists := object["webhook_subscriptions"]
	if !exists {
		return []WorkflowTrigger{}, nil
	}
	items, ok := raw.([]any)
	if !ok || !exactSchemaKeys(raw, reflect.TypeFor[[]CompilerTrigger]()) {
		return nil, ErrInvalid
	}
	for _, item := range items {
		declaration := item.(map[string]any)
		if repos, exists := declaration["repos"]; exists {
			if list, ok := repos.([]any); !ok || len(list) == 0 {
				return nil, ErrInvalid
			}
		}
		if _, ok := declaration["conditions"].([]any); !ok {
			return nil, ErrInvalid
		}
		if groups, exists := declaration["any_of"]; exists {
			if _, ok := groups.([]any); !ok {
				return nil, ErrInvalid
			}
		}
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, ErrInvalid
	}
	var declarations []CompilerTrigger
	if json.Unmarshal(encoded, &declarations) != nil {
		return nil, ErrInvalid
	}
	result := make([]WorkflowTrigger, 0, len(declarations))
	seen := make(map[string]bool)
	digest := MetadataDigest(data)
	for _, declaration := range declarations {
		if err := validateCompilerTrigger(declaration, workflow, id, l); err != nil || seen[declaration.Event] {
			return nil, ErrInvalid
		}
		seen[declaration.Event] = true
		result = append(result, WorkflowTrigger{ArtifactSHA256: digest, ManifestVersion: 1, Declaration: declaration})
	}
	return result, nil
}

func validateCompilerTrigger(t CompilerTrigger, workflow, id string, l Limits) error {
	if validateCompilerRepos(t, l) != nil {
		return ErrInvalid
	}
	d := t.Dispatch
	context := CompilerContext{Envelope: "github.event.client_payload", Event: "github.event.client_payload.event",
		Payload: "github.event.client_payload.payload", DeliveryID: "github.event.client_payload.delivery_id"}
	if t.SchemaVersion == 2 {
		context = CompilerContext{Envelope: "github.event.client_payload",
			AWContext: "github.event.client_payload.aw_context", Event: "github.event.client_payload.aw_context.webhook.event",
			Deliveries: "github.event.client_payload.aw_context.webhook.deliveries", Items: "aw_context.items"}
		if d.Batch == nil || *d.Batch != (CompilerBatch{Mode: "same-event", DeduplicateBy: "delivery_id"}) ||
			d.PayloadProjection == nil || d.PayloadProjection.Policy != compilerProjectionPolicy {
			return ErrInvalid
		}
		switch t.Event {
		case "dependabot_alert", "code_scanning_alert", "projects_v2_item":
		default:
			return ErrInvalid
		}
	} else if d.Batch != nil || d.PayloadProjection != nil {
		return ErrInvalid
	}
	if (t.SchemaVersion != 1 && t.SchemaVersion != 2) || !identifier(t.Event) || len(t.Types) == 0 ||
		d.Repository != "${{ github.repository }}" || d.Method != "repository_dispatch" ||
		d.Workflow != workflow || d.EventType != "gh-aw-webhook-"+MetadataDigest([]byte(id))[:24] ||
		d.Context != context ||
		d.MaxPayloadBytes < 1 || d.MaxPayloadBytes > d.MaxRequestBytes || d.MaxRequestBytes > 65535 {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, activity := range t.Types {
		if !identifier(activity) || seen[activity] || t.SchemaVersion == 2 && !compilerActivity(t.Event, activity) {
			return ErrInvalid
		}
		seen[activity] = true
	}
	total := len(t.Conditions)
	for _, group := range t.AnyOf {
		if len(group) == 0 {
			return ErrInvalid
		}
		total += len(group)
	}
	if total > l.MaxFilterNodes {
		return ErrInvalid
	}
	if err := validateCompilerConditions(t.Conditions, l); err != nil {
		return err
	}
	for _, group := range t.AnyOf {
		if err := validateCompilerConditions(group, l); err != nil {
			return err
		}
	}
	return nil
}

func validateCompilerConditions(conditions []CompilerCondition, l Limits) error {
	for _, c := range conditions {
		if c.Filter == "" || len(c.Filter) > l.MaxPathBytes || c.Operator != "equals" ||
			len(c.Path) == 0 || len(c.Path) > l.MaxPathSegments || len(c.Values) == 0 {
			return ErrInvalid
		}
		pathBytes := 0
		for _, segment := range c.Path {
			if segment == "" {
				return ErrInvalid
			}
			pathBytes += len(segment) + 1
		}
		if pathBytes > l.MaxPathBytes {
			return ErrInvalid
		}
		for _, raw := range c.Values {
			value, err := boundedJSON(raw, l.MaxMetadataBytes, l)
			if err != nil {
				return err
			}
			switch c.ValueType {
			case "string":
				if _, ok := value.(string); !ok {
					return ErrInvalid
				}
			case "boolean":
				if _, ok := value.(bool); !ok {
					return ErrInvalid
				}
			case "integer":
				number, ok := value.(json.Number)
				if !ok {
					return ErrInvalid
				}
				if _, err := number.Int64(); err != nil {
					return ErrInvalid
				}
			default:
				return ErrInvalid
			}
		}
	}
	return nil
}

// AddWorkflow rejects conflicting mappings rather than silently overwriting an
// earlier workflow revision. Native-only lock files contribute no webhook routes.
func (m *TriggerMapping) AddWorkflow(data []byte, workflow string, limits Limits) error {
	triggers, err := ParseWorkflowManifest(data, workflow, limits)
	if err != nil {
		return err
	}
	total := len(triggers)
	for _, routes := range m.ByEvent {
		total += len(routes)
		for _, route := range routes {
			if route.Declaration.Dispatch.Workflow == workflow {
				return ErrConflict
			}
		}
	}
	if total > DefaultLimits().MaxArrayItems {
		return ErrCapacity
	}
	if m.ByEvent == nil {
		return ErrInvalid
	}
	encoded, err := json.Marshal(triggers)
	if err != nil {
		return ErrInvalid
	}
	metadataBytes := len(encoded)
	for _, trigger := range triggers {
		metadataBytes += len(trigger.Declaration.Event) + 4
	}
	if m.metadataBytes+metadataBytes > 15<<20 {
		return ErrCapacity
	}
	for _, trigger := range triggers {
		event := trigger.Declaration.Event
		m.ByEvent[event] = append(m.ByEvent[event], trigger)
		slices.SortFunc(m.ByEvent[event], func(a, b WorkflowTrigger) int {
			return strings.Compare(a.Declaration.Dispatch.Workflow, b.Declaration.Dispatch.Workflow)
		})
	}
	m.metadataBytes += metadataBytes
	return nil
}

// Match returns discovery candidates only. It cannot authorize admission or
// dispatch, and never hydrates missing payload fields or reconstructs history.
func (m TriggerMapping) Match(event Event, limits Limits) ([]WorkflowTrigger, error) {
	l, err := resolveLimits(limits)
	if err != nil {
		return nil, err
	}
	root, err := boundedJSON(event.Payload, l.MaxEventBytes, l)
	if err != nil {
		return nil, err
	}
	object, ok := root.(map[string]any)
	if !ok || object["action"] != event.Action {
		return nil, ErrInvalid
	}
	var matches []WorkflowTrigger
	for _, route := range m.ByEvent[event.Name] {
		t := route.Declaration
		if !compilerTriggerMatches(t, root, event.Action) {
			continue
		}
		matches = append(matches, route)
	}
	return matches, nil
}

func compilerTriggerMatches(t CompilerTrigger, root any, action string) bool {
	return slices.Contains(t.Types, action) && compilerConditionsMatch(root, t.Conditions) &&
		(len(t.AnyOf) == 0 || slices.ContainsFunc(t.AnyOf, func(group []CompilerCondition) bool {
			return compilerConditionsMatch(root, group)
		}))
}

func compilerConditionsMatch(root any, conditions []CompilerCondition) bool {
	for _, c := range conditions {
		operands := make([]any, 0, len(c.Values))
		for _, raw := range c.Values {
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			var value any
			if err := decoder.Decode(&value); err != nil {
				return false
			}
			operands = append(operands, value)
		}
		if !compilerConditionMatch(root, c.Path, operands) {
			return false
		}
	}
	return true
}

func compilerConditionMatch(value any, path []string, expected []any) bool {
	if len(path) == 0 {
		if value == nil {
			return false
		}
		for _, operand := range expected {
			if same, comparable := equal(value, operand); comparable && same {
				return true
			}
		}
		return false
	}
	if path[0] == "*" {
		items, ok := value.([]any)
		return ok && slices.ContainsFunc(items, func(item any) bool {
			return compilerConditionMatch(item, path[1:], expected)
		})
	}
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	child, exists := object[path[0]]
	return exists && compilerConditionMatch(child, path[1:], expected)
}
