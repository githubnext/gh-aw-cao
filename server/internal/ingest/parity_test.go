package ingest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

// TestEvidenceShardPipelineParity compares both consumers of the same phased
// JSONL bytes, rather than comparing separately hand-built query inputs.
func TestEvidenceShardPipelineParity(t *testing.T) {
	if _, err := os.Stat("../../../dashboard/site/node_modules/fake-indexeddb"); os.IsNotExist(err) {
		if _, err := os.Stat("../../../node_modules/fake-indexeddb"); os.IsNotExist(err) {
			t.Skip("JS ingestion parity needs existing npm dependencies")
		} else if err != nil {
			t.Fatal(err)
		}
	} else if err != nil {
		t.Fatal(err)
	}
	directory, offset := testutil.RecentSnapshot(t, "../../testdata/deployed-subset")
	snapshot, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := snapshot.Close(); err != nil {
			t.Error(err)
		}
	})
	evidence, err := os.ReadFile("testdata/evidence.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	evidence = testutil.ShiftEvidence(t, evidence, offset)
	runEvidence := []json.RawMessage{}
	recordEvidence := []json.RawMessage{}
	for _, line := range bytes.Split(bytes.TrimSpace(evidence), []byte("\n")) {
		var entry struct {
			Collection string `json:"collection"`
		}
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatal(err)
		}
		if entry.Collection == "experiments" || entry.Collection == "experimentAssignments" {
			runEvidence = append(runEvidence, line)
		} else {
			recordEvidence = append(recordEvidence, line)
		}
	}
	if len(runEvidence) != 2 || len(recordEvidence) != 8 {
		t.Fatalf("expected two run-phase and eight record-phase evidence records, got %d and %d", len(runEvidence), len(recordEvidence))
	}

	runFixture, err := snapshot.ReadFile("gh-aw-logs-runs/subset.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	recordFixture, err := snapshot.ReadFile("gh-aw-logs-records/subset.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{}
	paths := map[string]string{}
	for _, phase := range []struct {
		name     string
		evidence []json.RawMessage
		fixture  []byte
	}{
		{"runs", runEvidence, runFixture},
		{"records", recordEvidence, recordFixture},
	} {
		lines := bytes.Split(bytes.TrimSpace(phase.fixture), []byte("\n"))
		var header map[string]any
		if err := json.Unmarshal(lines[0], &header); err != nil {
			t.Fatal(err)
		}
		// The deployed subset predates normalized evidence schema 17. Retain
		// its actual canonical records while updating the test shard envelope.
		header["schemaVersion"] = 23
		header["ingestionVersion"] = 4
		header["records"] = len(lines) - 1 + len(phase.evidence)
		metadata, err := json.Marshal(header)
		if err != nil {
			t.Fatal(err)
		}
		lines[0] = metadata
		for _, entry := range phase.evidence {
			lines = append(lines, entry)
		}
		content := append(bytes.Join(lines, []byte("\n")), '\n')
		name := fmt.Sprintf("gh-aw-logs-%s/subset.jsonl", phase.name)
		path := filepath.Join(directory, filepath.FromSlash(name))
		writeTestFile(t, path, content)
		paths[phase.name] = path
		hash := sha256.Sum256(content)
		manifest[name] = hex.EncodeToString(hash[:])
	}
	marshaled, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), marshaled)
	writeTestFile(t, filepath.Join(directory, "inventory-sources.json"), []byte("{}"))
	ctx, store := ingestTestStore(t)
	ingested, err := Run(ctx, store, directory, Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json"})
	if err != nil {
		t.Fatal(err)
	}
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	hosted, _, err := store.ExecuteSQLPlan(ctx, definitions, []string{"experiments", "experiment-assignments", "graders", "grader-observations", "evals", "eval-observations", "domains", "mcp-calls", "audits"})
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G204 -- arguments are shard files created in this test's scratch directory.
	command := exec.CommandContext(t.Context(), "node", "testdata/compare.mjs", paths["runs"], paths["records"])
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("JS canonical ingestion/query failed: %v\n%s", err, output)
	}
	var browser struct {
		CanonicalCounts map[string]int         `json:"canonicalCounts"`
		Rows            map[string][]model.Row `json:"rows"`
	}
	if err := json.Unmarshal(output, &browser); err != nil {
		t.Fatalf("decode JS projections: %v\n%s", err, output)
	}
	expectedFields := map[string]map[string]any{
		"experiments":            {"experiment": "prompt", "workflow": ".github/workflows/dashboard.md"},
		"experiment-assignments": {"variant": "candidate", "run": "424242", "experiment": "prompt"},
		"graders":                {"grader": "quality", "unit": "score", "threshold": float64(0.8)},
		"grader-observations":    {"value": float64(0.93), "status": "pass", "grader": "quality"},
		"evals":                  {"eval": "correctness", "workflow": ".github/workflows/dashboard.md"},
		"eval-observations":      {"eval-result": "YES", "status": "pass", "eval": "correctness", "audit-id": "audit:424242:correctness", "experiment-id": "experiment:dashboard:prompt", "variant": "candidate"},
	}
	for store, source := range map[string]string{
		"experiments":           "experiments",
		"experimentAssignments": "experiment-assignments",
		"graders":               "graders",
		"graderObservations":    "grader-observations",
		"evals":                 "evals",
		"evalObservations":      "eval-observations",
	} {
		if count := browser.CanonicalCounts[store]; count != 1 || ingested.Counts["$"+store] != 1 {
			t.Errorf("%s: expected one record in both canonical stores, JS=%d Postgres=%d", store, count, ingested.Counts["$"+store])
		}
		got := browser.Rows[source]
		want := hosted[source].Rows
		wire, _ := json.Marshal(want)
		if err := json.Unmarshal(wire, &want); err != nil {
			t.Fatal(err)
		}
		if len(got) == 1 {
			for field, expected := range expectedFields[source] {
				if !reflect.DeepEqual(got[0][field], expected) {
					t.Errorf("%s: JS %s = %v, want %v", source, field, got[0][field], expected)
				}
			}
			for source, evidence := range map[string]struct {
				field string
				id    string
				facts model.Row
			}{
				"domains":   {"id", "domain:424242:access", model.Row{"method": "GET", "response-bytes": float64(1024), "latency-ms": float64(7)}},
				"mcp-calls": {"mcp-observation", "tool:424242:call", model.Row{"mcp-server": "github", "mcp-tool": "get_issue", "response-bytes": float64(42)}},
				"audits":    {"id", "audit:424242:usage", model.Row{"component": "usage", "phase": "evals", "telemetry-model": "gpt-model", "telemetry-engine": "copilot", "input-tokens": float64(5), "duration-ms": float64(5)}},
			} {
				selectEvidence := func(rows []model.Row) model.Row {
					for _, row := range rows {
						if row[evidence.field] == evidence.id {
							return row
						}
					}
					return nil
				}
				got := selectEvidence(browser.Rows[source])
				wire, err := json.Marshal(selectEvidence(hosted[source].Rows))
				if err != nil {
					t.Fatal(err)
				}
				var want model.Row
				if err := json.Unmarshal(wire, &want); err != nil {
					t.Fatal(err)
				}
				if got == nil || !reflect.DeepEqual(got, want) {
					t.Fatalf("%s telemetry differs: JS=%v Postgres=%v", source, got, want)
				}
				for field, expected := range evidence.facts {
					if !reflect.DeepEqual(got[field], expected) {
						t.Errorf("%s %s=%v, want %v", source, field, got[field], expected)
					}
				}
			}
		}
		sort.Slice(got, func(i, j int) bool { return fmt.Sprint(got[i]["id"]) < fmt.Sprint(got[j]["id"]) })
		sort.Slice(want, func(i, j int) bool { return fmt.Sprint(want[i]["id"]) < fmt.Sprint(want[j]["id"]) })
		if len(got) != 1 || !reflect.DeepEqual(got, want) {
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(want)
			t.Errorf("%s: JS projected rows %s != Go projected rows %s", source, gotJSON, wantJSON)
		}
	}
}
