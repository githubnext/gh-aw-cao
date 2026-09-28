package operationalvalue

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseOutputRejectsExplicitNullOptionalFields(t *testing.T) {
	for _, field := range []string{
		"metricUnit", "adoptionAt", "evaluationMode", "workflowSlug", "workflowName",
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

func testEnvelope(valueID, timestamp string, value float64) envelope {
	const campaign = "example"
	return envelope{
		SchemaVersion: 2, Kind: "operational_value",
		OperationalValue: operationalValue{
			Timestamp: timestamp, Repository: "octo/api",
			Campaign: campaign, CampaignID: "campaign:" + campaign,
			ValueID: valueID, Value: value,
			MetricRole: "primary", MetricName: valueID, MetricDirection: "increase",
			MaturityStatus: "matured",
		},
	}
}

func TestPersistValuesRetiresInactiveValuesAndMergesDuplicates(t *testing.T) {
	retained := []envelope{
		testEnvelope("stale.value", "2026-09-01T00:00:00.000Z", 1),
		testEnvelope("current.value", "2026-09-01T00:00:00.000Z", 1),
	}
	fresh := []envelope{
		// Same exact key as the retained current.value entry, so merging must
		// replace it rather than keep both.
		testEnvelope("current.value", "2026-09-01T00:00:00.000Z", 2),
	}
	active := map[string]map[string]struct{}{
		"example": {"current.value": {}},
	}
	merged := persistValues(retained, fresh, active, map[string]definition{})
	if len(merged) != 1 {
		t.Fatalf("len(merged) = %d, want 1 (stale.value retired, current.value merged)", len(merged))
	}
	if merged[0].OperationalValue.ValueID != "current.value" || merged[0].OperationalValue.Value != 2 {
		t.Fatalf("merged[0] = %+v, want the freshest current.value", merged[0])
	}
}

func TestPersistValuesKeepsRetainedValuesWithoutActiveEntry(t *testing.T) {
	// A campaign that produced no definitions this run (e.g. it failed or was
	// skipped) must not retire every value it previously reported.
	retained := []envelope{
		testEnvelope("current.value", "2026-09-01T00:00:00.000Z", 1),
	}
	merged := persistValues(retained, nil, map[string]map[string]struct{}{}, map[string]definition{})
	if len(merged) != 1 || merged[0].OperationalValue.ValueID != "current.value" {
		t.Fatalf("merged = %+v, want the retained value kept", merged)
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
