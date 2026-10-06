package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestCompileQueriesCommandReadsAllFragmentsAndDatabaseQueries(t *testing.T) {
	directory := t.TempDir()
	fragments := filepath.Join(directory, "fragments")
	if err := os.Mkdir(fragments, 0750); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(directory, "dashboard.json"): `{"dashboard":{"queries":[{"name":"root","from":"runs","select":[{"field":"id"}]}]}}`,
		filepath.Join(fragments, "one.json"):       `{"queries":[{"name":"alpha","from":"runs","select":[{"field":"id"}]}]}`,
		filepath.Join(fragments, "two.json"):       `{"queries":[{"name":"beta","from":"alpha","select":[{"field":"id"}]}]}`,
		filepath.Join(directory, "database.json"):  `[{"name":"gamma","from":"jobs","select":[{"field":"id"}]}]`,
	} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := newCompileQueriesCommand()
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--dashboard-queries", filepath.Join(directory, "dashboard.json"), "--fragments", fragments, "--database-queries", filepath.Join(directory, "database.json"), "--format", "json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var results []queryValidation
	if err := json.Unmarshal(output.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 || results[0].Name != "root" || results[1].Name != "alpha" || results[2].Name != "beta" || results[3].Name != "gamma" {
		t.Fatalf("unexpected compilation report: %#v", results)
	}
	for _, result := range results {
		if !result.Valid {
			t.Fatalf("query not validated: %+v", result)
		}
	}
}

func TestValidateCompilationQueriesIsolatesEachDefinition(t *testing.T) {
	definitions := []query.Definition{
		{Name: "valid", From: "runs", Select: []query.SelectedField{{Field: "id"}}},
		{Name: "invalid", From: "runs", Predict: []json.RawMessage{json.RawMessage(`{}`)}},
	}
	results := validateCompilationQueries(definitions)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if !results[0].Valid || results[0].Reason != "" {
		t.Fatalf("expected first definition to validate cleanly: %+v", results[0])
	}
	if results[1].Valid || results[1].Reason == "" {
		t.Fatalf("expected second definition to fail validation with a reason: %+v", results[1])
	}
}

func TestSummarizeCompilationValidityCountsBothOutcomes(t *testing.T) {
	results := []queryValidation{
		{Name: "a", Valid: true},
		{Name: "b", Valid: true},
		{Name: "c", Valid: false, Reason: "unsupported"},
	}
	valid, invalid := summarizeCompilationValidity(results)
	if valid != 2 || invalid != 1 {
		t.Fatalf("expected valid=2 invalid=1, got valid=%d invalid=%d", valid, invalid)
	}
}

func TestSummarizeCompilationValidityHandlesEmptyResults(t *testing.T) {
	valid, invalid := summarizeCompilationValidity(nil)
	if valid != 0 || invalid != 0 {
		t.Fatalf("expected zero counts for nil input, got valid=%d invalid=%d", valid, invalid)
	}
}

func TestFragmentFileNamesSkipsSubdirectoriesAndNonJSONFiles(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "nested.json"), 0750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha.json", "beta.json", "readme.md", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	names := fragmentFileNames(entries)
	if len(names) != 2 || names[0] != "alpha.json" || names[1] != "beta.json" {
		t.Fatalf("expected only the JSON files in order, got %v", names)
	}
}

func TestFragmentFileNamesHandlesEmptyDirectory(t *testing.T) {
	entries, err := os.ReadDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if names := fragmentFileNames(entries); len(names) != 0 {
		t.Fatalf("expected no fragment names for an empty directory, got %v", names)
	}
}

func TestCompileQueriesFailsOnMissingInputsAndUnknownFormat(t *testing.T) {
	_, err := loadCompilationQueries("", filepath.Join(t.TempDir(), "missing"), "database.json")
	if err == nil {
		t.Fatal("missing fragments directory must fail closed")
	}
	if err := renderCompilation(&bytes.Buffer{}, nil, "xml"); err == nil {
		t.Fatal("unknown output format must fail")
	}
	var output bytes.Buffer
	if err := renderCompilation(&output, []queryValidation{{Name: "a|b", From: "line\nbreak", Valid: true}}, "markdown"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `a\|b`) || !strings.Contains(output.String(), "line break") {
		t.Fatalf("report cells were not escaped: %s", output.String())
	}
}

func TestCompileQueriesReportsUnsupportedGoFeatures(t *testing.T) {
	directory := t.TempDir()
	fragments := filepath.Join(directory, "fragments")
	if err := os.Mkdir(fragments, 0750); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(directory, "dashboard.json"): `{"queries":[{"name":"unsupported","from":"runs","predict":[{}]}]}`,
		filepath.Join(directory, "database.json"):  `[]`,
	} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := newCompileQueriesCommand()
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--dashboard-queries", filepath.Join(directory, "dashboard.json"), "--fragments", fragments, "--database-queries", filepath.Join(directory, "database.json"), "--format", "json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var results []queryValidation
	if err := json.Unmarshal(output.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Valid || !strings.Contains(results[0].Reason, "prediction") {
		t.Fatalf("unsupported Go query was not reported: %#v", results)
	}
}
