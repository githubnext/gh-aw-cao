package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
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
	var results []redisx.QueryCompilation
	if err := json.Unmarshal(output.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 || results[0].Name != "alpha" || results[1].Level != "fallback" || results[2].Name != "gamma" || results[3].Name != "root" {
		t.Fatalf("unexpected compilation report: %#v", results)
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
	if err := renderCompilation(&output, []redisx.QueryCompilation{{Name: "a|b", Level: "fallback", Reason: "line\nbreak"}}, "markdown"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `a\|b`) || !strings.Contains(output.String(), "line break") {
		t.Fatalf("report cells were not escaped: %s", output.String())
	}
}

func TestSummarizeCompilationLevelsCountsEachLevel(t *testing.T) {
	counts := summarizeCompilationLevels([]redisx.QueryCompilation{
		{Name: "a", Level: "full candidate"},
		{Name: "b", Level: "fallback"},
		{Name: "c", Level: "fallback"},
		{Name: "d", Level: "unsupported"},
	})
	if counts["full candidate"] != 1 || counts["fallback"] != 2 || counts["unsupported"] != 1 || counts["partial candidate"] != 0 {
		t.Fatalf("unexpected level counts: %#v", counts)
	}
}

func TestSummarizeCompilationLevelsHandlesEmptyResults(t *testing.T) {
	counts := summarizeCompilationLevels(nil)
	if len(counts) != 0 {
		t.Fatalf("expected no counts for empty results, got: %#v", counts)
	}
}
