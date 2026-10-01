package postgresx

import (
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
	if values[0] != "run:1" || values[1] != nil || values[5] != "completed" ||
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
		{"id": json.Number("9007199254740993")},
		{"createdAt": "not-a-timestamp"},
		{"status": []any{"completed"}},
		{"organizationLink": map[string]any{"href": "https://github.com", "title": "extra"}},
	} {
		if _, _, _, ok, err := canonicalRow(row); err != nil || ok {
			t.Fatalf("expected lossless legacy fallback for %#v: ok=%t err=%v", row, ok, err)
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
		!reflect.DeepEqual(fields, []string{"attempt"}) || extension != "{}" {
		t.Fatalf("wide number storage: values=%#v present=%v extension=%s", values[index:], fields, extension)
	}
}

func TestOnlyIngestCollectionsAreCanonical(t *testing.T) {
	for _, name := range []string{"$runs", "$jobs", "$operationalValues", "$evalObservations"} {
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
		if err != nil || !ok || extension != "{}" {
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
