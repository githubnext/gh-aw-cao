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
