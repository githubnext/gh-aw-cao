package operationalvalue

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPeriodAssessmentDomains(t *testing.T) {
	base := map[string]any{
		"timestamp": "2026-09-24T10:00:00Z", "repository": "octo/api",
		"valueId": "worker.current", "value": nil, "maturityStatus": "unavailable",
		"windowStart": "2026-09-17T10:00:00Z", "windowEnd": "2026-09-24T10:00:00Z",
		"measurementKind": "interval", "coverageStatus": "missing", "missingReason": "source-inaccessible",
	}
	raw, _ := json.Marshal(base)
	parsed, err := parseOutput(raw, "adapter", []string{"octo/api"})
	if err != nil || len(parsed.values) != 1 || envelopes("example", parsed.values)[0].OperationalValue.Value != nil {
		t.Fatalf("unavailable assessment not preserved: %+v, %v", parsed, err)
	}
	for field, invalid := range map[string]any{
		"windowStart": nil, "windowEnd": "2026-09-25T10:00:00Z",
		"measurementKind": []string{"interval"}, "coverageStatus": []string{"complete"},
		"missingReason": " ", "eligibleCount": 1.5, "evidenceDigest": strings.Repeat("A", 64),
		"rollupNumerator": 1, "maturityStatus": "matured",
	} {
		t.Run(field, func(t *testing.T) {
			record := make(map[string]any, len(base))
			for key, value := range base {
				record[key] = value
			}
			record[field] = invalid
			raw, _ := json.Marshal(record)
			if _, err := parseOutput(raw, "adapter", []string{"octo/api"}); err == nil {
				t.Fatalf("accepted invalid period metadata: %s", raw)
			}
		})
	}
}

func TestParseOutputRejectsExplicitNullOptionalFields(t *testing.T) {
	for _, field := range []string{
		"metricUnit", "adoptionAt", "evaluationMode", "workflowSlug", "workflowName", "evaluatorDigest", "cadenceDays",
	} {
		t.Run(field, func(t *testing.T) {
			record := fmt.Sprintf(
				`{"timestamp":"2026-09-24T10:00:00Z","repository":"octo/api","valueId":"example.value","value":1,%q:null}`,
				field,
			)
			if _, err := parseOutput([]byte(record+"\n"), "adapter", []string{"octo/api"}); err == nil {
				t.Fatalf("expected explicit null %s to be rejected", field)
			}
		})
	}
	for _, record := range []string{
		`{"timestamp":"2026-09-24T10:00:00Z","repository":"octo/api","valueId":"example.value","value":1,"rollupNumerator":null,"rollupDenominator":null}`,
		`{"timestamp":"2026-09-24T10:00:00Z","repository":"octo/api","valueId":"example.value","value":1,"rollupNumerator":1}`,
	} {
		if _, err := parseOutput([]byte(record+"\n"), "adapter", []string{"octo/api"}); err == nil {
			t.Fatal("expected malformed rollup fields to be rejected")
		}
	}
}

func TestCadenceValidationAndPublication(t *testing.T) {
	for _, cadence := range []string{"0", "-1", `"7"`, "null", "2.5"} {
		record := fmt.Sprintf(
			`{"timestamp":"2026-10-14T00:00:00Z","repository":"octo/api","valueId":"example.value","value":4,"cadenceDays":%s}`,
			cadence,
		)
		parsed, err := parseOutput([]byte(record+"\n"), "adapter", []string{"octo/api"})
		if cadence != "2.5" {
			if err == nil {
				t.Fatalf("accepted invalid cadence %s", cadence)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		values := envelopes("example", parsed.values)
		if values[0].OperationalValue.CadenceDays == nil || *values[0].OperationalValue.CadenceDays != 2.5 {
			t.Fatal("cadence not preserved")
		}
	}
}

func TestEvaluatorDigestValidationAndPublication(t *testing.T) {
	for _, digest := range []string{`["` + strings.Repeat("a", 64) + `"]`, "64", "{}"} {
		record := fmt.Sprintf(
			`{"timestamp":"2026-09-24T10:00:00Z","repository":"octo/api","valueId":"example.value","value":0,"evaluatorDigest":%s}`,
			digest,
		)
		if _, err := parseOutput([]byte(record+"\n"), "adapter", []string{"octo/api"}); err == nil {
			t.Fatalf("accepted non-string evaluator fingerprint %s", digest)
		}
	}
	for _, digest := range []string{"", "legacy", strings.Repeat("A", 64), strings.Repeat("a", 64)} {
		record := fmt.Sprintf(
			`{"timestamp":"2026-09-24T10:00:00Z","repository":"octo/api","valueId":"example.value","value":0,"evaluatorDigest":%q}`,
			digest,
		)
		parsed, err := parseOutput([]byte(record+"\n"), "adapter", []string{"octo/api"})
		if digest != strings.Repeat("a", 64) {
			if err == nil {
				t.Fatal("expected malformed evaluator fingerprint to be rejected")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		values := envelopes("example", parsed.values)
		if len(values) != 1 || values[0].OperationalValue.EvaluatorDigest == nil ||
			*values[0].OperationalValue.EvaluatorDigest != digest {
			t.Fatalf("evaluator fingerprint not preserved: %+v", values)
		}
	}
}

func testEnvelope(valueID string, value float64) envelope {
	const campaign = "example"
	const timestamp = "2026-09-01T00:00:00.000Z"
	return envelope{
		SchemaVersion: 2, Kind: "operational_value",
		OperationalValue: operationalValue{
			Timestamp: timestamp, Repository: "octo/api",
			Campaign: campaign, CampaignID: "campaign:" + campaign,
			ValueID: valueID, Value: &value,
			MetricRole: "primary", MetricName: valueID, MetricDirection: "increase",
			MaturityStatus: "matured",
		},
	}
}

func TestDefaultRetentionKeepsYearBoundary(t *testing.T) {
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "observations.jsonl")
	lines := make([]string, 0, 3)
	for _, age := range []int{40, 365, 366} {
		lines = append(lines, fmt.Sprintf(
			`{"schema_version":2,"kind":"operational_value","operational_value":{"timestamp":%q,"campaign":"example","repository":"octo/api","value_id":"alerts","value":0}}`,
			now.Add(-time.Duration(age)*day).Format(time.RFC3339),
		))
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := readRetained(path, now.Add(-DefaultRetention))
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 {
		t.Fatalf("retained %d observations, want ages 40 and 365 days", len(values))
	}
	for index, age := range []int{40, 365} {
		if values[index].OperationalValue.Timestamp != now.Add(-time.Duration(age)*day).Format(time.RFC3339) {
			t.Fatalf("unexpected retained timestamp: %s", values[index].OperationalValue.Timestamp)
		}
	}
}

func TestPersistValuesRetiresInactiveValuesAndMergesDuplicates(t *testing.T) {
	retained := []envelope{
		testEnvelope("stale.value", 1),
		testEnvelope("current.value", 1),
	}
	fresh := []envelope{
		// Same exact key as the retained current.value entry, so merging must
		// replace it rather than keep both.
		testEnvelope("current.value", 2),
	}
	active := map[string]map[string]struct{}{
		"example": {"current.value": {}},
	}
	merged := persistValues(retained, fresh, active, map[string]definition{})
	if len(merged) != 1 {
		t.Fatalf("len(merged) = %d, want 1 (stale.value retired, current.value merged)", len(merged))
	}
	if merged[0].OperationalValue.ValueID != "current.value" || merged[0].OperationalValue.Value == nil || *merged[0].OperationalValue.Value != 2 {
		t.Fatalf("merged[0] = %+v, want the freshest current.value", merged[0])
	}
}

func TestPeriodCompactionRetainsAdjacentCutoffsAndVersions(t *testing.T) {
	adoptedAt, _ := parseTimestamp("2026-09-15T00:00:00Z")
	item := definition{AdoptedAt: adoptedAt, CadenceDays: 1}
	period := func(timestamp, start, end, digest string) envelope {
		value := testEnvelope("current.value", 3)
		kind := "interval"
		value.OperationalValue.Timestamp = timestamp
		value.OperationalValue.WindowStart = &start
		value.OperationalValue.WindowEnd = &end
		value.OperationalValue.MeasurementKind = &kind
		value.OperationalValue.EvaluatorDigest = &digest
		return value
	}
	values := []envelope{
		period("2026-09-23T12:00:00Z", "2026-09-16T00:00:00Z", "2026-09-23T00:00:00Z", "a"),
		period("2026-09-24T00:00:00Z", "2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z", "a"),
		period("2026-09-24T01:00:00Z", "2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z", "b"),
		period("2026-09-24T02:00:00Z", "2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z", "b"),
	}
	merged := mergeValues(values, map[string]definition{definitionKey("example", "current.value"): item})
	if len(merged) != 3 || merged[2].OperationalValue.Timestamp != "2026-09-24T02:00:00Z" {
		t.Fatalf("distinct periods and evaluators must survive, newest correction wins: %+v", merged)
	}
	item.EvaluationMode = "attainment-only"
	times, err := historicalTimes(item, adoptedAt.Add(3*day), DefaultRetention)
	if err != nil || len(times) != 2 || !times[0].After(adoptedAt) {
		t.Fatalf("attainment history must begin with a positive-duration period: %v, %v", times, err)
	}
}

func TestPersistValuesKeepsRetainedValuesWithoutActiveEntry(t *testing.T) {
	// A campaign that produced no definitions this run (e.g. it failed or was
	// skipped) must not retire every value it previously reported.
	retained := []envelope{
		testEnvelope("current.value", 1),
	}
	merged := persistValues(retained, nil, map[string]map[string]struct{}{}, map[string]definition{})
	if len(merged) != 1 || merged[0].OperationalValue.ValueID != "current.value" {
		t.Fatalf("merged = %+v, want the retained value kept", merged)
	}
}

func TestEvaluateRateLimitReserveBlockingSkipsAdapterAtOrBelowReserve(t *testing.T) {
	cases := []struct {
		name        string
		remaining   int
		reserve     int
		wantWarning bool
		wantSkip    bool
	}{
		{name: "above reserve", remaining: 101, reserve: 100, wantWarning: false, wantSkip: false},
		{name: "at reserve", remaining: 100, reserve: 100, wantWarning: true, wantSkip: true},
		{name: "below reserve", remaining: 99, reserve: 100, wantWarning: true, wantSkip: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			check := evaluateRateLimitReserve(testCase.remaining, testCase.reserve, rateLimitCheckBlocking)
			if (check.warning != "") != testCase.wantWarning {
				t.Fatalf("warning = %q, wantWarning = %t", check.warning, testCase.wantWarning)
			}
			if check.skipAdapter != testCase.wantSkip {
				t.Fatalf("skipAdapter = %t, want %t", check.skipAdapter, testCase.wantSkip)
			}
		})
	}
}

func TestEvaluateRateLimitReserveFinalOnlyWarnsStrictlyBelowReserve(t *testing.T) {
	// The final check reports whether the floor was crossed after every
	// adapter ran; it must never skip an adapter and must use a strict
	// comparison so exactly-at-reserve does not warn, unlike the blocking
	// check performed before each adapter.
	cases := []struct {
		name        string
		remaining   int
		reserve     int
		wantWarning bool
	}{
		{name: "above reserve", remaining: 101, reserve: 100, wantWarning: false},
		{name: "at reserve", remaining: 100, reserve: 100, wantWarning: false},
		{name: "below reserve", remaining: 99, reserve: 100, wantWarning: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			check := evaluateRateLimitReserve(testCase.remaining, testCase.reserve, rateLimitCheckFinal)
			if (check.warning != "") != testCase.wantWarning {
				t.Fatalf("warning = %q, wantWarning = %t", check.warning, testCase.wantWarning)
			}
			if check.skipAdapter {
				t.Fatal("final check must never request skipping an adapter")
			}
		})
	}
}

func TestDiscoverScriptsFindsAdaptersSortedByCampaign(t *testing.T) {
	root := t.TempDir()
	for _, campaign := range []string{"zeta", "alpha"} {
		directory := filepath.Join(root, campaign)
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(
			filepath.Join(directory, "operational-value.mjs"), []byte("// adapter\n"), 0o600,
		); err != nil {
			t.Fatal(err)
		}
	}
	// A directory without the adapter file must be skipped rather than
	// reported as a campaign.
	if err := os.MkdirAll(filepath.Join(root, "no-adapter"), 0o750); err != nil {
		t.Fatal(err)
	}
	scripts, err := discoverScripts(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(scripts) != 2 || scripts[0].campaign != "alpha" || scripts[1].campaign != "zeta" {
		t.Fatalf("scripts = %+v, want [alpha, zeta] sorted", scripts)
	}
}

func TestDiscoverScriptsReturnsEmptyForDirectoryWithoutCampaigns(t *testing.T) {
	scripts, err := discoverScripts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(scripts) != 0 {
		t.Fatalf("scripts = %+v, want empty", scripts)
	}
}

func TestCollectorTerminatesTimedOutAdapterProcessTree(t *testing.T) {
	root := t.TempDir()
	campaign := filepath.Join(root, "example")
	if err := os.MkdirAll(campaign, 0o750); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "orphan")
	descendant := filepath.Join(campaign, "descendant.mjs")
	if err := os.WriteFile(descendant, []byte(`
import { writeFileSync } from "node:fs";
setTimeout(() => writeFileSync(process.argv[2], "alive"), 150);
setInterval(() => {}, 1000);
`), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := fmt.Sprintf(`
import { spawn } from "node:child_process";
spawn(process.execPath, [%q, %q]);
setInterval(() => {}, 1000);
`, descendant, marker)
	if err := os.WriteFile(
		filepath.Join(campaign, "operational-value.mjs"), []byte(adapter), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	result, err := Collect(context.Background(), Config{
		Root: root, Database: filepath.Join(root, "activity.sqlite"),
		Output:       filepath.Join(root, "values.jsonl"),
		ObservedAt:   time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC),
		Repositories: []string{"octo/api"},
		NodeBinary:   "node", Environment: testEnvironment(),
		WorkerTimeout: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("warnings = %v, want one timeout", result.Warnings)
	}
	time.Sleep(250 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("timed-out adapter left a descendant process running")
	}
}
