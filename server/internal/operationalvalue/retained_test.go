package operationalvalue

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilterRepositoriesPreservesUnrelatedLinesAndExtensions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operational-values.jsonl")
	target := `{"schema_version":2,"kind":"operational_value","operational_value":{"repository":"Octo/API","timestamp":"2026-10-01T00:00:00Z"}}`
	other := `{"schema_version":2,"kind":"operational_value","operational_value":{"repository":"octo/api-extra","custom":{"accepted":true},"timestamp":"2020-01-01T00:00:00Z"}}`
	if err := os.WriteFile(path, []byte(target+"\n"+other+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := FilterRepositories(path, func(repository string) bool { return repository != "octo/api" }); err != nil {
			t.Fatal(err)
		}
		content, err := os.ReadFile(path) // #nosec G304 -- test-owned temporary fixture.
		if err != nil || string(content) != other+"\n" {
			t.Fatalf("unrelated evidence was changed: %q, %v", content, err)
		}
	}
	if err := FilterRepositories(path, func(string) bool { return false }); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(path); err != nil || len(content) != 0 { // #nosec G304 -- test-owned temporary fixture.
		t.Fatalf("zero scope retained evidence: %q, %v", content, err)
	}
}

func TestFilterRepositoriesFailsClosedWithoutReplacingEvidence(t *testing.T) {
	for _, invalid := range []string{
		`not JSON`,
		`{"schema_version":2,"kind":"operational_value_evidence"}`,
		`{"schema_version":2,"kind":"operational_value","operational_value":{"repository":"invalid"}}`,
		strings.Repeat("x", maxWorkerOutput+1),
	} {
		path := filepath.Join(t.TempDir(), "operational-values.jsonl")
		content := []byte(invalid + "\n")
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := FilterRepositories(path, func(string) bool { return false }); err == nil {
			t.Fatal("invalid retained evidence was accepted")
		}
		got, err := os.ReadFile(path) // #nosec G304 -- test-owned temporary fixture.
		if err != nil || string(got) != string(content) {
			t.Fatal("failed filter replaced retained evidence")
		}
	}
	if err := FilterRepositories(filepath.Join(t.TempDir(), "missing.jsonl"), func(string) bool { return false }); err != nil {
		t.Fatal(err)
	}
}
