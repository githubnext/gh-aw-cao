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

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

// TestEvidenceShardPipelineParity compares both consumers of the same phased
// JSONL bytes, rather than comparing separately hand-built query inputs.
func TestEvidenceShardPipelineParity(t *testing.T) {
	if _, err := os.Stat("../../../dashboard/site/node_modules/fake-indexeddb"); os.IsNotExist(err) {
		t.Skip("JS ingestion parity needs dashboard/site's existing npm dependencies (installed by Redis dashboard integration CI)")
	} else if err != nil {
		t.Fatal(err)
	}
	const deployed = "../../testdata/deployed-subset"
	directory := scratchDirectory(t)
	evidence, err := os.ReadFile("testdata/evidence.jsonl")
	if err != nil {
		t.Fatal(err)
	}
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
	if len(runEvidence) != 2 || len(recordEvidence) != 4 {
		t.Fatalf("expected two run-phase and four record-phase evidence records, got %d and %d", len(runEvidence), len(recordEvidence))
	}

	manifest := Manifest{}
	paths := map[string]string{}
	for _, phase := range []struct {
		name     string
		evidence []json.RawMessage
	}{
		{"runs", runEvidence}, {"records", recordEvidence},
	} {
		source := filepath.Join(deployed, "gh-aw-logs-"+phase.name, "subset.jsonl")
		original, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		lines := bytes.Split(bytes.TrimSpace(original), []byte("\n"))
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
	_, runs, records, err := ValidateManifest(directory)
	if err != nil {
		t.Fatal(err)
	}
	canonical := map[string][]model.Row{}
	for _, collection := range collections {
		canonical[collection] = []model.Row{}
	}
	for _, name := range append(runs, records...) {
		if err := readShard(filepath.Join(directory, filepath.FromSlash(name)), canonical); err != nil {
			t.Fatal(err)
		}
	}
	if errors := relationshipErrors(canonical); len(errors) != 0 {
		t.Fatalf("invalid evidence relationships: %v", errors)
	}
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	hosted, err := projectSources(canonical, nil, definitions)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("node", "testdata/compare.mjs", paths["runs"], paths["records"])
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
		"eval-observations":      {"eval-result": "YES", "status": "pass", "eval": "correctness"},
	}
	for store, source := range map[string]string{
		"experiments":           "experiments",
		"experimentAssignments": "experiment-assignments",
		"graders":               "graders",
		"graderObservations":    "grader-observations",
		"evals":                 "evals",
		"evalObservations":      "eval-observations",
	} {
		if count := browser.CanonicalCounts[store]; count != 1 || len(canonical[store]) != 1 {
			t.Errorf("%s: expected one record in both canonical stores, JS=%d Go=%d", store, count, len(canonical[store]))
		}
		got := browser.Rows[source]
		want := hosted[source].Rows
		if len(got) == 1 {
			for field, expected := range expectedFields[source] {
				if !reflect.DeepEqual(got[0][field], expected) {
					t.Errorf("%s: JS %s = %v, want %v", source, field, got[0][field], expected)
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
