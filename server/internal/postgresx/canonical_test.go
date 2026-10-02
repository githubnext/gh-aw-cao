package postgresx

import (
	"database/sql"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestCanonicalRowSeparatesKnownAndOpenFields(t *testing.T) {
	input := model.Row{
		"id": "run:1", "runId": nil, "status": "completed",
		"organizationLink": map[string]any{"href": "https://github.com/githubnext"},
		"attempt":          json.Number("9007199254740993"), "sequence": nil,
		"createdAt": "2026-10-01T15:12:09.123456789-07:00",
		"open":      map[string]any{"large": json.Number("1e1000000")},
		"empty":     nil,
	}
	present, values, extension, ok, err := canonicalRow(input)
	if err != nil || !ok {
		t.Fatalf("canonical row: ok=%t err=%v", ok, err)
	}
	if !reflect.DeepEqual(present, []string{"attempt", "createdAt", "id", "organizationLink", "runId", "sequence", "status"}) {
		t.Fatalf("presence: %v", present)
	}
	if values[0] != "run:1" || values[1] != nil || values[6] != "completed" ||
		values[len(canonicalFields)+1] != input["createdAt"] ||
		values[len(canonicalFields)+2*len(canonicalTimes)] != "9007199254740993" {
		t.Fatalf("relational values: %#v", values)
	}
	var rest model.Row
	if err := decodeJSON([]byte(extension), &rest); err != nil {
		t.Fatal(err)
	}
	if _, duplicated := rest["id"]; duplicated {
		t.Fatal("canonical id duplicated in extension")
	}
	if _, duplicated := rest["runId"]; duplicated {
		t.Fatal("explicit null duplicated in extension")
	}
	if _, duplicated := rest["attempt"]; duplicated {
		t.Fatal("native numeric duplicated in extension")
	}
	if _, duplicated := rest["organizationLink"]; duplicated {
		t.Fatal("native link duplicated in extension")
	}
	if !reflect.DeepEqual(rest, model.Row{"open": input["open"], "empty": nil}) {
		t.Fatalf("open extension: %#v", rest)
	}
}

func TestCanonicalRowRejectsNonNativeKnownValues(t *testing.T) {
	for _, row := range []model.Row{
		{"id": []any{json.Number("9007199254740993")}},
		{"createdAt": "not-a-timestamp"},
		{"status": []any{"completed"}},
		{"organizationLink": map[string]any{"href": "https://github.com", "title": "extra"}},
	} {
		if _, _, _, ok, err := canonicalRow(row); err != nil || ok {
			t.Fatalf("unsupported known representation must be rejected: %#v ok=%t err=%v", row, ok, err)
		}
	}
}

func TestCanonicalNumericIDRetainsNativeLexeme(t *testing.T) {
	lexeme := json.Number("1e1000000")
	fields, values, extension, ok, err := canonicalRow(model.Row{"id": lexeme})
	if err != nil || !ok || extension != "" ||
		!reflect.DeepEqual(fields, []string{"id"}) ||
		values[0] != string(lexeme) || values[len(values)-8] != "number" {
		t.Fatalf("numeric ID representation: fields=%v values=%v extension=%q ok=%t err=%v",
			fields, values, extension, ok, err)
	}
}

func TestCanonicalFilterBindsBooleanPredicates(t *testing.T) {
	where, args := canonicalFilter("tenant", "$runs",
		map[string]any{"id": "run-1", "enabled": true, "isPullRequest": false})
	if !strings.Contains(where, "id = $3") ||
		!strings.Contains(where, "enabled = $4") ||
		!strings.Contains(where, "is_pull_request = $5") ||
		!reflect.DeepEqual(args, []any{"tenant", "$runs", "run-1", true, false}) {
		t.Fatalf("native boolean predicate binding: where=%q args=%#v", where, args)
	}
}

func TestCanonicalNullExtensionDecodesAsEmptyRow(t *testing.T) {
	row, err := decodeCanonicalExtension(sql.NullString{})
	if err != nil || row == nil || len(row) != 0 {
		t.Fatalf("null canonical extension: %#v, %v", row, err)
	}
}

func TestCanonicalContentsRequiresStringArray(t *testing.T) {
	for _, value := range []any{
		"worker.md", true, json.Number("1"), map[string]any{"path": "worker.md"},
		[]any{map[string]any{"path": "worker.md"}}, []any{nil}, []any{"worker.md", false},
	} {
		row := model.Row{"contents": value}
		if _, _, _, ok, err := canonicalRow(row); ok || err != nil {
			t.Fatalf("malformed known contents must be rejected: value=%#v ok=%t err=%v", value, ok, err)
		}
		if !strings.Contains(canonicalFallbackReason(row), "contents") {
			t.Fatalf("malformed contents lack field diagnostic: %#v", value)
		}
	}
	for _, value := range []any{nil, []any{}, []any{"docs/b.md", "", "docs/b.md", "worker.md"}} {
		present, _, extension, ok, err := canonicalRow(model.Row{"contents": value})
		if !ok || err != nil || extension != "" || !reflect.DeepEqual(present, []string{"contents"}) {
			t.Fatalf("native contents shape changed: value=%#v present=%v extension=%q ok=%t err=%v",
				value, present, extension, ok, err)
		}
	}
}

func TestCanonicalProvenanceNativeShape(t *testing.T) {
	for _, provenance := range []any{
		map[string]any{"source": "gh-aw-logs", "sourceId": nil,
			"observedAt": "2026-10-01T12:00:00.123456789-07:00", "sourceRevision": "v1"},
		map[string]any{}, nil,
	} {
		fields, values, extension, ok, err := canonicalRow(model.Row{"provenance": provenance})
		if err != nil || !ok || extension != "" ||
			!reflect.DeepEqual(fields, []string{"provenance"}) ||
			values[len(values)-7] == nil && provenance != nil && !reflect.DeepEqual(provenance, map[string]any{}) {
			t.Fatalf("native provenance: fields=%v extension=%s ok=%t err=%v", fields, extension, ok, err)
		}
	}
	for _, provenance := range []any{
		map[string]any{"source": "gh-aw-logs", "extra": "unknown"},
		map[string]any{"observedAt": "invalid"},
		map[string]any{"sourceId": json.Number("2")},
		[]any{},
	} {
		if _, _, _, ok, err := canonicalRow(model.Row{"provenance": provenance}); ok || err != nil {
			t.Fatalf("unsupported provenance shape silently stored: %#v ok=%t err=%v",
				provenance, ok, err)
		}
	}
}

func TestCanonicalNumberBeyondPostgresNumericRange(t *testing.T) {
	fields, values, extension, ok, err := canonicalRow(model.Row{"attempt": json.Number("1e1000000")})
	if err != nil || !ok {
		t.Fatalf("wide number must retain lossless typed row: ok=%t err=%v", ok, err)
	}
	index := len(canonicalFields) + 2*len(canonicalTimes)
	if values[index] != nil || values[index+1] != "1e1000000" ||
		!reflect.DeepEqual(fields, []string{"attempt"}) || extension != "" {
		t.Fatalf("wide number storage: values=%#v present=%v extension=%s", values[index:], fields, extension)
	}
}

func TestOnlyIngestCollectionsAreCanonical(t *testing.T) {
	for _, name := range []string{"$runs", "$jobs", "$operationalValues", "$evalObservations", "$marketplacePackages"} {
		if !isCanonicalSource(name) {
			t.Fatalf("missing canonical ingest collection %q", name)
		}
	}
	for _, name := range []string{"runs", "repositories", "$unknown", "custom-inventory"} {
		if isCanonicalSource(name) {
			t.Fatalf("schemaless inventory source classified as canonical: %q", name)
		}
	}
}

func TestCanonicalTimestampRawOnlyForExceptionalLexemes(t *testing.T) {
	index := len(canonicalFields)
	for _, tt := range []struct {
		value   string
		wantRaw any
	}{
		{"2026-09-23T18:00:00Z", nil},
		{"2026-09-23T18:00:00.123456Z", nil},
		{"2026-09-23T18:00:00.123456789Z", "2026-09-23T18:00:00.123456789Z"},
		{"2026-09-23T20:00:00+02:00", "2026-09-23T20:00:00+02:00"},
	} {
		_, values, _, ok, err := canonicalRow(model.Row{"createdAt": tt.value})
		if err != nil || !ok || values[index+1] != tt.wantRaw {
			t.Fatalf("timestamp %q: raw=%v expected=%v err=%v", tt.value, values[index+1], tt.wantRaw, err)
		}
	}
}

func TestDeployedCoreFixtureHasOnlyNativeKnownFields(t *testing.T) {
	data, err := os.ReadFile("../../testdata/deployed-subset/gh-aw-logs-runs/subset.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n")[1:] {
		var record struct {
			Collection string    `json:"collection"`
			Record     model.Row `json:"record"`
		}
		if err := decodeJSON([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if !isCanonicalSource("$" + record.Collection) {
			t.Fatalf("unregistered canonical collection %q", record.Collection)
		}
		_, _, extension, ok, err := canonicalRow(record.Record)
		if err != nil || !ok || extension != "" {
			t.Fatalf("known %s fixture fields must be native: extension=%s ok=%t err=%v",
				record.Collection, extension, ok, err)
		}
	}
}

func TestNativeNumbersOmitOrdinaryRawCopies(t *testing.T) {
	index := len(canonicalFields) + 2*len(canonicalTimes)
	for _, sample := range []struct {
		number  string
		wantRaw any
	}{
		{"9007199254740993", nil}, {"0.00012300", nil},
		{"1e3", "1e3"}, {"-0", "-0"},
	} {
		_, values, _, ok, err := canonicalRow(model.Row{"attempt": json.Number(sample.number)})
		if err != nil || !ok || values[index+1] != sample.wantRaw {
			t.Fatalf("%q: raw=%v want=%v err=%v", sample.number, values[index+1], sample.wantRaw, err)
		}
	}
}

func TestCanonicalProducerFieldsNeverBecomeOpenExtensions(t *testing.T) {
	row := model.Row{
		"id": "observation:1", "runId": "run:1", "graderId": "grader:1",
		"experimentId": "experiment:1", "auditId": "audit:1",
		"sourceGraderId": "quality", "variant": "optimized",
		"firstObservedAt":     "2026-10-01T12:00:00Z",
		"resultTimestamp":     "2026-10-01T12:00:00Z",
		"evidenceWindowStart": "2026-09-01T12:00:00Z",
		"statusObservedAt":    "2026-10-01T12:00:00Z",
		"value":               json.Number("1.25"), "threshold": nil,
		"inputTokens":      json.Number("9007199254740993"),
		"rollup-numerator": json.Number("1e3"),
		"issueClosed":      false, "included": nil,
		"runLink":              "https://github.com/org/repo/actions/runs/1",
		"provenance":           map[string]any{"source": "gh-aw", "observedAt": "2026-10-01T12:00:00Z"},
		"metrics":              []any{map[string]any{"value": json.Number("1e3")}},
		"attributableRunIds":   []any{"run:1", "run:2"},
		"implementationRunIds": []any{},
	}

	present, _, extension, ok, err := canonicalRow(row)
	if err != nil || !ok || extension != "" || len(present) != len(row) {
		t.Fatalf("producer fields became extension or fallback: present=%v extension=%s ok=%t err=%v",
			present, extension, ok, err)
	}

	for _, invalid := range []model.Row{
		{"metrics": "not-an-array"}, {"attributableRunIds": []any{json.Number("123")}},
		{"value": []any{"not scalar"}}, {"issueClosed": "false"}, {"runLink": map[string]any{"url": "wrong"}},
	} {
		if _, _, _, ok, _ := canonicalRow(invalid); ok {
			t.Fatalf("unsupported known producer shape was not rejected: %#v", invalid)
		}
		mixed := model.Row{
			"value": "1.25", "answer": map[string]any{"response": "YES"},
			"evalResult": []any{"YES", "NO"}, "costGrain": map[string]any{"unit": "run"},
		}
		present, _, extension, ok, err = canonicalRow(mixed)
		if err != nil || !ok || len(present) != len(mixed) || extension != "" {
			t.Fatalf("colliding evidence fields were not native: present=%v extension=%s ok=%t err=%v",
				present, extension, ok, err)
		}
	}
}

func TestDeclarativeIngestionProducerKeysAreNative(t *testing.T) {
	payload, err := os.ReadFile("../../../dashboard/site/src/data/queries/ingestion.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		Observations []struct {
			Data map[string]json.RawMessage `json:"data"`
		} `json:"observations"`
		RunLinkedData map[string]json.RawMessage `json:"runLinkedData"`
	}
	if err := json.Unmarshal(payload, &declaration); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, group := range [][]struct{ key, column string }{
		canonicalFields, canonicalTimes, canonicalNumbers, canonicalBooleans,
		canonicalIdentifiers, canonicalLinks, canonicalArrays, canonicalObjects,
	} {
		for _, field := range group {
			known[field.key] = true
		}
	}
	for _, observation := range declaration.Observations {
		for key := range observation.Data {
			if !known[key] {
				t.Errorf("declarative producer field %q lacks a native column", key)
			}
		}
	}
	for key := range declaration.RunLinkedData {
		if !known[key] {
			t.Errorf("run-linked producer field %q lacks a native column", key)
		}
	}
}
