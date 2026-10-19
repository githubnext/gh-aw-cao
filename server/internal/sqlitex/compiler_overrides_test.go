package sqlitex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestNativeCompilerReleaseOverridesHistoryBeforeRetainedInventory(t *testing.T) {
	path := nativeSnapshot(t, map[string][]model.Row{"workflows": {
		{"id": "workflow:retained", "repositoryId": "repository:octo%2Frepo", "path": ".github/workflows/first.md",
			"ghAwVersion": "v0.91.5", "ghAwCurrentVersion": "v0.91.5", "ghAwUpdateState": "up-to-date"},
		{"id": "workflow:historical", "repositoryId": "repository:octo%2Frepo", "path": ".github/workflows/old.md",
			"ghAwVersion": "v0.90.0", "ghAwCurrentVersion": "v0.91.5", "ghAwUpdateState": "update-available", "name": "Historical"},
		{"id": "workflow:placeholder", "name": "Placeholder"},
	}})
	putInventory(t, path, map[string]model.Source{"workflows": {Rows: []model.Row{{
		"organization": "octo", "repository": "repo", "workflow": "first.lock.yml",
		"gh-aw-version": "v0.92.0", "gh-aw-current-version": "v0.92.0", "gh-aw-update-state": "unknown",
	}}}})
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	overrides := map[string]model.Row{}
	for _, id := range []string{"workflow:retained", "workflow:historical", "workflow:placeholder", "workflow:unknown"} {
		overrides[id] = model.Row{"ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "update-available"}
	}
	content, err := json.Marshal(overrides)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "compiler-overrides.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	after, err := store.State(t.Context())
	if err != nil || before.DataRevision == after.DataRevision || before.Revision == after.Revision {
		t.Fatalf("compiler sidecar did not invalidate revision: %#v %#v %v", before, after, err)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"$workflows"})
	if err != nil {
		t.Fatal(err)
	}
	index := map[string]model.Row{}
	for _, row := range sources["$workflows"].Rows {
		index[row["id"].(string)] = row
	}
	if len(index) != 3 {
		t.Fatalf("compiler overrides invented unknown workflows: %#v", index)
	}
	if row := index["workflow:retained"]; row["ghAwVersion"] != "v0.92.0" || row["ghAwCurrentVersion"] != "v0.92.0" || row["ghAwUpdateState"] != "unknown" {
		t.Fatalf("retained inventory lost precedence over release comparison: %#v", row)
	}
	if row := index["workflow:historical"]; row["ghAwVersion"] != "v0.90.0" || row["ghAwCurrentVersion"] != "v0.92.0" ||
		row["ghAwUpdateState"] != "update-available" || row["name"] != "Historical" {
		t.Fatalf("historical release refresh changed installed evidence: %#v", row)
	}
	if row := index["workflow:placeholder"]; row["ghAwCurrentVersion"] != "v0.92.0" || row["ghAwVersion"] != nil || row["ghAwUpdateState"] != nil {
		t.Fatalf("placeholder acquired installed compiler evidence: %#v", row)
	}
}

func TestNativeCompilerOverridesRejectNonCompilerFields(t *testing.T) {
	path := nativeSnapshot(t, map[string][]model.Row{"workflows": {{"id": "workflow:one"}}})
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "compiler-overrides.json"),
		[]byte(`{"workflow:one":{"ghAwVersion":"v0.92.0"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if store, err := Open(t.Context(), path); err == nil {
		_ = store.Close()
		t.Fatal("release sidecar was allowed to invent installed-version evidence")
	}
}
