package webhookgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// MetadataDigest binds the exact trusted artifact bytes, not a mutable display name.
func MetadataDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func digestOK(s string) bool {
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == sha256.Size && s == strings.ToLower(s)
}

func identifier(s string) bool {
	if len(s) == 0 || len(s) > 200 {
		return false
	}
	for _, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' {
			continue
		}
		return false
	}
	return true
}

func nodeID(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	for _, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '+' || c == '/' || c == '=' {
			continue
		}
		return false
	}
	return true
}

func exactSchemaKeys(value any, typ reflect.Type) bool {
	if typ == reflect.TypeFor[json.RawMessage]() {
		return true
	}
	if typ.Kind() == reflect.Pointer {
		return value == nil || exactSchemaKeys(value, typ.Elem())
	}
	switch typ.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return false
		}
		fields := make(map[string]reflect.Type, typ.NumField())
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			fields[strings.Split(field.Tag.Get("json"), ",")[0]] = field.Type
		}
		for key, child := range object {
			field, exists := fields[key]
			if !exists || !exactSchemaKeys(child, field) {
				return false
			}
		}
	case reflect.Slice:
		if value == nil {
			return true
		}
		array, ok := value.([]any)
		if !ok {
			return false
		}
		for _, item := range array {
			if !exactSchemaKeys(item, typ.Elem()) {
				return false
			}
		}
	default:
		return true
	}
	return true
}

// ParseSubscription rejects unknown schema fields, duplicate keys, and unsupported versions.
// This proposed artifact contract is not a gh-aw frontmatter compiler; upstream compiler
// integration is pending, and contract fixtures do not establish compiler end-to-end coverage.
func ParseSubscription(data []byte, limits Limits) (Subscription, error) {
	l, err := resolveLimits(limits)
	if err != nil {
		return Subscription{}, err
	}
	tree, err := boundedJSON(data, l.MaxMetadataBytes, l)
	if err != nil {
		return Subscription{}, err
	}
	if !exactSchemaKeys(tree, reflect.TypeFor[Subscription]()) {
		return Subscription{}, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	var s Subscription
	if err := d.Decode(&s); err != nil {
		return Subscription{}, ErrInvalid
	}
	if err := ValidateSubscription(s, l); err != nil {
		return Subscription{}, err
	}
	return s, nil
}

// ValidateSubscription validates compiler metadata without granting operational authority.
func ValidateSubscription(s Subscription, limits Limits) error {
	l, err := resolveLimits(limits)
	if err != nil {
		return err
	}
	if s.SchemaVersion != "gh-aw.webhook-subscription/v1" || s.Provider != "github" ||
		!identifier(s.ID) || !identifier(s.TenantID) || s.AppID <= 0 ||
		!identifier(s.Source.ID) || !identifier(s.Source.Event) || s.Source.InstallationID <= 0 ||
		s.Source.RepositoryID < 0 || s.Source.OrganizationID < 0 ||
		(s.Source.RepositoryID == 0 && s.Source.OrganizationID == 0) ||
		s.Destination.InstallationID <= 0 || s.Destination.RepositoryID <= 0 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	if len(s.Source.ProjectIDs) > l.MaxArrayItems || len(s.Source.IdentityConstraints) > l.MaxFilterNodes ||
		len(s.Source.RequiredPermissions) > 128 {
		return ErrInvalid
	}
	for _, id := range s.Source.ProjectIDs {
		if !nodeID(id) || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	for name, level := range s.Source.RequiredPermissions {
		if !identifier(name) || (level != "read" && level != "write") {
			return ErrInvalid
		}
	}
	projectBound := len(s.Source.ProjectIDs) == 0
	for _, c := range s.Source.IdentityConstraints {
		if _, err := pointer(c.Path, l); err != nil {
			return err
		}
		value, err := boundedJSON(c.Value, l.MaxMetadataBytes, l)
		if err != nil || value == nil {
			return ErrInvalid
		}
		values, array := value.([]any)
		if !array {
			values = []any{value}
		}
		if len(values) == 0 {
			return ErrInvalid
		}
		var ids []string
		for _, item := range values {
			if !scalar(item) || item == nil {
				return ErrInvalid
			}
			if id, ok := item.(string); ok {
				ids = append(ids, id)
			}
		}
		if len(ids) == len(values) && sameIDs(ids, s.Source.ProjectIDs) {
			projectBound = true
		}
	}
	if !projectBound {
		return ErrInvalid
	}
	d := s.Destination
	switch d.Kind {
	case "workflow_dispatch":
		if len(d.Workflow) == 0 || len(d.Workflow) > 200 || strings.ContainsAny(d.Workflow, "/\\?#") ||
			d.Workflow == "." || d.Workflow == ".." || len(d.Ref) == 0 || len(d.Ref) > 255 ||
			strings.ContainsAny(d.Ref, "\r\n\x00") || d.EventType != "" {
			return ErrInvalid
		}
	case "repository_dispatch":
		if !identifier(d.EventType) || len(d.EventType) > 100 || d.Workflow != "" || d.Ref != "" {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	if len(d.Fields) > l.MaxDispatchProperties {
		return ErrInvalid
	}
	names := map[string]bool{}
	for _, f := range d.Fields {
		if !identifier(f.Name) || f.Name == "_gateway" || names[f.Name] || (f.Path == nil) == (len(f.Literal) == 0) {
			return ErrInvalid
		}
		names[f.Name] = true
		if f.Path != nil {
			if _, err := pointer(*f.Path, l); err != nil {
				return err
			}
		} else if _, err := boundedJSON(f.Literal, l.MaxDispatchBytes, l); err != nil {
			return err
		}
	}
	p := s.Delivery
	if p.TTLSeconds < 1 || p.TTLSeconds > 7*24*3600 ||
		p.LeaseSeconds < 1 || p.LeaseSeconds > p.TTLSeconds ||
		p.MaxAttempts < 1 || p.MaxAttempts > 100 ||
		p.RetryDelaySeconds < 1 || p.RetryDelaySeconds > p.TTLSeconds {
		return ErrInvalid
	}
	if s.Filter != nil {
		nodes := 0
		if err := validateFilter(*s.Filter, l, 1, &nodes); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(s)
	if err != nil || len(encoded) > l.MaxMetadataBytes {
		return ErrInvalid
	}
	return nil
}

// ParseEvent extracts only common GitHub envelope fields; the shell supplies SourceID.
func ParseEvent(deliveryID, name string, payload []byte, limits Limits) (Event, error) {
	l, err := resolveLimits(limits)
	if err != nil || !identifier(deliveryID) || !identifier(name) {
		return Event{}, ErrInvalid
	}
	root, err := boundedJSON(payload, l.MaxEventBytes, l)
	if err != nil {
		return Event{}, err
	}
	m, ok := root.(map[string]any)
	if !ok {
		return Event{}, ErrInvalid
	}
	e := Event{DeliveryID: deliveryID, Name: name, Payload: append(json.RawMessage(nil), payload...)}
	if action, exists := m["action"]; exists {
		e.Action, ok = action.(string)
		if !ok || !identifier(e.Action) {
			return Event{}, ErrInvalid
		}
	}
	ids := []struct {
		name string
		out  *int64
	}{{"installation", &e.InstallationID}, {"repository", &e.RepositoryID}, {"organization", &e.OrganizationID}}
	for _, field := range ids {
		object, exists := m[field.name]
		if !exists || object == nil {
			continue
		}
		child, ok := object.(map[string]any)
		if !ok {
			return Event{}, ErrInvalid
		}
		number, ok := child["id"].(json.Number)
		if !ok {
			return Event{}, ErrInvalid
		}
		id, err := strconv.ParseInt(string(number), 10, 64)
		if err != nil || id <= 0 {
			return Event{}, ErrInvalid
		}
		*field.out = id
	}
	return e, nil
}

// MatchSubscription selects payload matches only; it never supplies authorization.
func MatchSubscription(s Subscription, event Event, limits Limits) (bool, error) {
	if err := ValidateSubscription(s, limits); err != nil {
		return false, err
	}
	l, _ := resolveLimits(limits)
	root, err := boundedJSON(event.Payload, l.MaxEventBytes, l)
	if err != nil {
		return false, err
	}
	parsed, err := ParseEvent(event.DeliveryID, event.Name, event.Payload, l)
	if err != nil || parsed.InstallationID != event.InstallationID ||
		parsed.RepositoryID != event.RepositoryID || parsed.OrganizationID != event.OrganizationID ||
		parsed.Action != event.Action {
		return false, ErrInvalid
	}
	if s.Source.ID != event.SourceID || s.Source.Event != event.Name ||
		s.Source.InstallationID != event.InstallationID ||
		(s.Source.RepositoryID != 0 && s.Source.RepositoryID != event.RepositoryID) ||
		(s.Source.OrganizationID != 0 && s.Source.OrganizationID != event.OrganizationID) {
		return false, nil
	}
	for _, c := range s.Source.IdentityConstraints {
		value, exists := lookup(root, c.Path, l)
		expected, _ := boundedJSON(c.Value, l.MaxMetadataBytes, l)
		if !exists || !identityMatches(value, expected) {
			return false, nil
		}
	}
	return s.Filter == nil || evaluate(*s.Filter, root, l) == True, nil
}

func identityMatches(value, expected any) bool {
	if allowed, ok := expected.([]any); ok {
		for _, candidate := range allowed {
			same, compatible := equal(value, candidate)
			if compatible && same {
				return true
			}
		}
		return false
	}
	same, compatible := equal(value, expected)
	return compatible && same
}

// BuildDispatchPayload emits only declared properties and caps the complete GitHub request.
func BuildDispatchPayload(s Subscription, event Event, limits Limits) (json.RawMessage, error) {
	if err := ValidateSubscription(s, limits); err != nil {
		return nil, err
	}
	l, _ := resolveLimits(limits)
	root, err := boundedJSON(event.Payload, l.MaxEventBytes, l)
	if err != nil {
		return nil, err
	}
	properties := make(map[string]any)
	for _, field := range s.Destination.Fields {
		var value any
		if field.Path != nil {
			var exists bool
			value, exists = lookup(root, *field.Path, l)
			if !exists {
				if field.Required {
					return nil, ErrInvalid
				}
				continue
			}
			if !safeProjection(value) {
				return nil, ErrInvalid
			}
		} else {
			value, err = boundedJSON(field.Literal, l.MaxDispatchBytes, l)
			if err != nil {
				return nil, err
			}
		}
		if s.Destination.Kind == "workflow_dispatch" && (value == nil || !scalar(value)) {
			return nil, ErrInvalid
		}
		properties[field.Name] = value
	}
	var request map[string]any
	if s.Destination.Kind == "workflow_dispatch" {
		request = map[string]any{"ref": s.Destination.Ref, "inputs": properties}
	} else {
		request = map[string]any{"event_type": s.Destination.EventType, "client_payload": properties}
	}
	data, err := json.Marshal(request)
	if err != nil || len(data) > l.MaxDispatchBytes ||
		(s.Destination.Kind == "repository_dispatch" && len(data) >= 65536) {
		return nil, ErrInvalid
	}
	return data, nil
}

// JobDimensions partitions budgets with unambiguous, immutable identity components.
func JobDimensions(j Job) Dimensions {
	s := j.Subscription
	app := strconv.FormatInt(s.AppID, 10)
	destination := strconv.FormatInt(s.Destination.InstallationID, 10) + ":" +
		strconv.FormatInt(s.Destination.RepositoryID, 10)
	source := strconv.FormatInt(s.Source.InstallationID, 10) + ":" +
		strconv.FormatInt(s.Source.RepositoryID, 10) + ":" + strconv.FormatInt(s.Source.OrganizationID, 10)
	return Dimensions{App: app, Tenant: s.TenantID, Source: source, Destination: destination,
		Workflow: destination + ":" + s.Destination.Kind + ":" + s.Destination.Workflow + ":" + s.Destination.EventType}
}

func validRevision(r Revision) bool {
	if r.RepositoryID <= 0 || !digestOK(r.Digest) || !identifier(r.CompilerID) ||
		r.MetadataPath == "" || len(r.MetadataPath) > 512 || strings.ContainsAny(r.MetadataPath, "\\\x00") ||
		path.IsAbs(r.MetadataPath) || path.Clean(r.MetadataPath) != r.MetadataPath ||
		r.MetadataPath == ".." || strings.HasPrefix(r.MetadataPath, "../") {
		return false
	}
	if len(r.CommitSHA) != 40 && len(r.CommitSHA) != 64 {
		return false
	}
	_, err := hex.DecodeString(r.CommitSHA)
	return err == nil && r.CommitSHA == strings.ToLower(r.CommitSHA)
}

func durationSeconds(seconds int64) time.Duration {
	return time.Duration(seconds) * time.Second
}
