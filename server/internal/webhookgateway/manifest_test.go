package webhookgateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func manifestFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact strings.Builder
	var document any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	compact.WriteString("# Generated workflow\n# gh-aw-manifest: ")
	compact.Write(encoded)
	compact.WriteString("\nname: test\non: [repository_dispatch, workflow_dispatch]\n")
	return []byte(compact.String())
}

func TestCompilerManifestTriggerMapping(t *testing.T) {
	data := manifestFixture(t)
	mapping := NewTriggerMapping()
	if err := mapping.AddWorkflow(data, ".github/workflows/test.lock.yml", DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	if !mapping.DiscoveryOnly || len(mapping.ByEvent) != 4 {
		t.Fatalf("incorrect discovery map: %+v", mapping)
	}
	for _, event := range []string{"projects_v2_item", "dependabot_alert", "code_scanning_alert", "secret_scanning_alert"} {
		routes := mapping.ByEvent[event]
		if len(routes) != 1 || routes[0].ArtifactSHA256 != MetadataDigest(data) ||
			routes[0].Declaration.Dispatch.Workflow != ".github/workflows/test.lock.yml" ||
			routes[0].Declaration.Dispatch.MaxRequestBytes != 65535 {
			t.Fatalf("lost compiler route or artifact identity: %+v", routes)
		}
	}
	if len(mapping.ByEvent["workflow_dispatch"]) != 0 || len(mapping.ByEvent["security_advisory"]) != 0 {
		t.Fatal("native or unselected events became webhook subscriptions")
	}
	if err := mapping.AddWorkflow(data, ".github/workflows/test.lock.yml", DefaultLimits()); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate workflow mapping was not rejected", err)
	}
	changed := append(append([]byte{}, data...), []byte("# changed compiled steps\n")...)
	before, _ := ParseWorkflowManifest(data, ".github/workflows/test.lock.yml", DefaultLimits())
	after, err := ParseWorkflowManifest(changed, ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil || before[0].ArtifactSHA256 == after[0].ArtifactSHA256 {
		t.Fatal("artifact digest did not bind compiled steps", err)
	}
}

func TestCompilerManifestPairedTransitions(t *testing.T) {
	mapping := NewTriggerMapping()
	if err := mapping.AddWorkflow(manifestFixture(t), ".github/workflows/test.lock.yml", DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, project, field, from, to string
		match                          bool
	}{
		{"first-pair", "PVT_one", "Status", `"Todo"`, `"Ready"`, true},
		{"second-pair", "PVT_two", "Status", `"In progress"`, `"Done"`, true},
		{"cross-product", "PVT_one", "Status", `"Todo"`, `"Done"`, false},
		{"reverse-cross-product", "PVT_one", "Status", `"In progress"`, `"Ready"`, false},
		{"other-project", "PVT_other", "Status", `"Todo"`, `"Ready"`, false},
		{"wrong-field", "PVT_one", "Priority", `"Todo"`, `"Ready"`, false},
		{"null-operand", "PVT_one", "Status", `null`, `"Ready"`, false},
		{"typed-operand", "PVT_one", "Status", `42`, `"Ready"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"action":"edited","projects_v2_item":{"project_node_id":"` + tc.project +
				`"},"changes":{"field_value":{"field_name":"` + tc.field +
				`","field_type":"single_select","from":{"name":` + tc.from + `},"to":{"name":` + tc.to + `}}}}`
			matches, err := mapping.Match(Event{Name: "projects_v2_item", Action: "edited", Payload: json.RawMessage(body)}, DefaultLimits())
			if err != nil || (len(matches) == 1) != tc.match {
				t.Fatalf("paired transition match=%v want=%v err=%v", len(matches), tc.match, err)
			}
		})
	}
	for _, body := range []string{
		`{"action":"edited","projects_v2_item":{"project_node_id":"PVT_one"}}`,
		`{"action":"edited","projects_v2_item":{"project_node_id":"PVT_one"},"changes":{"field_value":{"field_node_id":"PVTF_one","field_type":"single_select"}}}`,
	} {
		matches, err := mapping.Match(Event{Name: "projects_v2_item", Action: "edited", Payload: json.RawMessage(body)}, DefaultLimits())
		if err != nil || len(matches) != 0 {
			t.Fatal("missing operands matched without delivered evidence", matches, err)
		}
	}
}

func TestCompilerManifestTypedSelectors(t *testing.T) {
	mapping := NewTriggerMapping()
	if err := mapping.AddWorkflow(manifestFixture(t), ".github/workflows/test.lock.yml", DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, event, action, body string
		match                     bool
	}{
		{"integer-and-array", "code_scanning_alert", "created", `{"action":"created","alert":{"number":42,"assignees":[{"login":"other"},{"login":"octocat"}]}}`, true},
		{"string-not-integer", "code_scanning_alert", "created", `{"action":"created","alert":{"number":"42","assignees":[{"login":"octocat"}]}}`, false},
		{"object-not-wildcard-array", "code_scanning_alert", "created", `{"action":"created","alert":{"number":42,"assignees":{"*":{"login":"octocat"}}}}`, false},
		{"boolean", "secret_scanning_alert", "created", `{"action":"created","alert":{"publicly_leaked":true}}`, true},
		{"string-not-boolean", "secret_scanning_alert", "created", `{"action":"created","alert":{"publicly_leaked":"true"}}`, false},
		{"selected-severity", "dependabot_alert", "reopened", `{"action":"reopened","alert":{"security_advisory":{"severity":"critical"}}}`, true},
		{"unselected-activity", "dependabot_alert", "fixed", `{"action":"fixed","alert":{"security_advisory":{"severity":"critical"}}}`, false},
		{"unselected-severity", "dependabot_alert", "created", `{"action":"created","alert":{"security_advisory":{"severity":"low"}}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			matches, err := mapping.Match(Event{Name: tc.event, Action: tc.action, Payload: json.RawMessage(tc.body)}, DefaultLimits())
			if err != nil || (len(matches) == 1) != tc.match {
				t.Fatalf("typed selector match=%v want=%v err=%v", len(matches), tc.match, err)
			}
		})
	}
}

func TestCompilerManifestRejectsInvalidDiscovery(t *testing.T) {
	fixture := string(manifestFixture(t))
	for _, tc := range []struct {
		name string
		data string
	}{
		{"missing", "name: no-manifest\n"},
		{"duplicate", fixture + fixture},
		{"not-preamble", "name: wrong\n" + fixture},
		{"multiline", "# gh-aw-manifest: {\n\"version\":1}\n"},
		{"bad-json", "# gh-aw-manifest: {broken}\n"},
		{"duplicate-key", strings.Replace(fixture, `"version":1`, `"version":1,"version":1`, 1)},
		{"manifest-version", strings.Replace(fixture, `"version":1`, `"version":2`, 1)},
		{"schema-version", strings.Replace(fixture, `"schema_version":1`, `"schema_version":2`, 1)},
		{"null-array", "# gh-aw-manifest: {\"version\":1,\"webhook_subscriptions\":null}\n"},
		{"null-entry", "# gh-aw-manifest: {\"version\":1,\"webhook_subscriptions\":[null]}\n"},
		{"missing-conditions", strings.Replace(fixture, `"conditions":`, `"omitted_conditions":`, 1)},
		{"null-conditions", strings.Replace(fixture, `"conditions":[`, `"conditions":null,"extra":[`, 1)},
		{"unknown-field", strings.Replace(fixture, `"schema_version":1`, `"schema_version":1,"future":true`, 1)},
		{"wrong-workflow", strings.ReplaceAll(fixture, "test.lock.yml", "other.lock.yml")},
		{"wrong-route", strings.ReplaceAll(fixture, "gh-aw-webhook-9f86d081884c7d659a2feaa0", "gh-aw-webhook-other")},
		{"wrong-destination", strings.ReplaceAll(fixture, "${{ github.repository }}", "unapproved/repository")},
		{"wrong-context", strings.ReplaceAll(fixture, "github.event.client_payload.payload", "github.event")},
		{"oversized-transport", strings.ReplaceAll(fixture, `"max_request_bytes":65535`, `"max_request_bytes":65536`)},
		{"unknown-operator", strings.ReplaceAll(fixture, `"operator":"equals"`, `"operator":"regex"`)},
		{"wrong-type", strings.Replace(fixture, `"value_type":"integer"`, `"value_type":"string"`, 1)},
		{"empty-pair", strings.Replace(fixture, `"any_of":[[`, `"any_of":[[],[`, 1)},
		{"empty-values", strings.Replace(fixture, `"values":[42]`, `"values":[]`, 1)},
		{"oversized-lock", fixture + strings.Repeat("x", MaxWorkflowArtifactBytes)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseWorkflowManifest([]byte(tc.data), ".github/workflows/test.lock.yml", DefaultLimits()); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
	if _, err := ParseWorkflowManifest([]byte(fixture), ".github/workflows/../test.lock.yml", DefaultLimits()); err == nil {
		t.Fatal("escaping workflow identity accepted")
	}
	if _, err := ParseWorkflowManifest([]byte(fixture), ".github/workflows/test.lock.yml", Limits{MaxMetadataBytes: 64}); err == nil {
		t.Fatal("metadata byte ceiling ignored")
	}
	if _, err := ParseWorkflowManifest([]byte(fixture), ".github/workflows/test.lock.yml", Limits{MaxFilterNodes: 2}); err == nil {
		t.Fatal("predicate node ceiling ignored")
	}
	for _, native := range []string{`{"version":1}`, `{"version":1,"webhook_subscriptions":[]}`} {
		triggers, err := ParseWorkflowManifest([]byte("# gh-aw-manifest: "+native+"\n"), ".github/workflows/native.lock.yml", DefaultLimits())
		if err != nil || len(triggers) != 0 {
			t.Fatal("native-only workflow did not produce an empty mapping", triggers, err)
		}
	}
}

func TestCompilerManifestWorkflowFanoutIsDeterministic(t *testing.T) {
	fixture := string(manifestFixture(t))
	second := strings.ReplaceAll(fixture, "test.lock.yml", "second.lock.yml")
	second = strings.ReplaceAll(second, "gh-aw-webhook-9f86d081884c7d659a2feaa0", "gh-aw-webhook-"+MetadataDigest([]byte("second"))[:24])
	first, reversed := NewTriggerMapping(), NewTriggerMapping()
	for _, mapping := range []*TriggerMapping{&first, &reversed} {
		data, path := []byte(fixture), ".github/workflows/test.lock.yml"
		other, otherPath := []byte(second), ".github/workflows/second.lock.yml"
		if mapping == &reversed {
			data, path, other, otherPath = other, otherPath, data, path
		}
		if err := mapping.AddWorkflow(data, path, DefaultLimits()); err != nil {
			t.Fatal(err)
		}
		if err := mapping.AddWorkflow(other, otherPath, DefaultLimits()); err != nil {
			t.Fatal(err)
		}
	}
	a, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(reversed)
	if err != nil || string(a) != string(b) || len(first.ByEvent["projects_v2_item"]) != 2 {
		t.Fatal("workflow fanout depends on file enumeration order", err)
	}
}

func TestCompilerManifestIndexBounds(t *testing.T) {
	fixture := string(manifestFixture(t))
	mapping := NewTriggerMapping()
	for i := range 257 {
		id := fmt.Sprintf("mapped-%03d", i)
		data := strings.NewReplacer("test.lock.yml", id+".lock.yml",
			"gh-aw-webhook-9f86d081884c7d659a2feaa0", "gh-aw-webhook-"+MetadataDigest([]byte(id))[:24]).Replace(fixture)
		err := mapping.AddWorkflow([]byte(data), ".github/workflows/"+id+".lock.yml", DefaultLimits())
		if i == 256 {
			if !errors.Is(err, ErrCapacity) {
				t.Fatal("1025th route did not fail closed", err)
			}
		} else if err != nil {
			t.Fatal("inventory below 1024 routes was rejected", i, err)
		}
	}
	total := 0
	for _, routes := range mapping.ByEvent {
		total += len(routes)
	}
	if total != 1024 {
		t.Fatal("capacity rejection changed the retained mapping", total)
	}

	var large map[string]any
	header := strings.SplitN(strings.TrimPrefix(fixture, "# Generated workflow\n# gh-aw-manifest: "), "\n", 2)[0]
	if err := json.Unmarshal([]byte(header), &large); err != nil {
		t.Fatal(err)
	}
	declarations := large["webhook_subscriptions"].([]any)
	conditions := declarations[0].(map[string]any)["conditions"].([]any)
	conditions[0].(map[string]any)["values"] = []string{
		strings.Repeat("a", 60000), strings.Repeat("b", 60000), strings.Repeat("c", 60000),
	}
	encoded, err := json.Marshal(large)
	if err != nil {
		t.Fatal(err)
	}
	largeFixture := "# gh-aw-manifest: " + string(encoded) + "\n"
	bounded := NewTriggerMapping()
	for i := range 100 {
		id := fmt.Sprintf("large-%03d", i)
		data := strings.NewReplacer("test.lock.yml", id+".lock.yml",
			"gh-aw-webhook-9f86d081884c7d659a2feaa0", "gh-aw-webhook-"+MetadataDigest([]byte(id))[:24]).Replace(largeFixture)
		before := bounded.metadataBytes
		err := bounded.AddWorkflow([]byte(data), ".github/workflows/"+id+".lock.yml", DefaultLimits())
		if errors.Is(err, ErrCapacity) {
			if bounded.metadataBytes != before || before > 15<<20 || before < (15<<20)-len(data)-2048 {
				t.Fatal("mapping byte budget was not enforced at the declared threshold", before)
			}
			output, err := json.Marshal(bounded)
			if err != nil || len(output) > 16<<20 {
				t.Fatal("mapping output exceeded framing budget", len(output), err)
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Fatal("large inventory bypassed declaration memory budget")
}

func TestCompilerManifestEscapedNamesAndCRLF(t *testing.T) {
	fixture := strings.ReplaceAll(string(manifestFixture(t)), `"Ready"`, `"Ready\nfor review"`)
	fixture = strings.ReplaceAll(fixture, "\n", "\r\n")
	mapping := NewTriggerMapping()
	if err := mapping.AddWorkflow([]byte(fixture), ".github/workflows/test.lock.yml", DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"action":"edited","projects_v2_item":{"project_node_id":"PVT_one"},"changes":{"field_value":{"field_name":"Status","field_type":"single_select","from":{"name":"Todo"},"to":{"name":"Ready\nfor review"}}}}`)
	matches, err := mapping.Match(Event{Name: "projects_v2_item", Action: "edited", Payload: payload}, DefaultLimits())
	if err != nil || len(matches) != 1 {
		t.Fatal("escaped single-line header values did not survive mapping", err)
	}
}
