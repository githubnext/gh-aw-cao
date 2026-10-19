package localpreview

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func addCanonicalWorkflow(t *testing.T, databasePath string, workflow object) {
	t.Helper()
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	content, err := json.Marshal(workflow)
	if err != nil {
		t.Fatal(err)
	}
	key, err := json.Marshal(workflow["id"])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES ('gh-aw-cao-dashboard-data','workflows',?,?)`, string(key), string(content)); err != nil {
		t.Fatal(err)
	}
}

func TestCanonicalCompilerOverridesPreserveHistoricalEvidenceAndPlaceholders(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	path := filepath.Join(data, "gh-aw-logs.sqlite")
	for _, workflow := range []object{
		{"id": "workflow:historical", "ghAwVersion": "v0.91.5", "ghAwUpdateState": "up-to-date", "observedAt": "2026-10-01T00:00:00Z"},
		{"id": "workflow:current", "ghAwVersion": "v0.92.0"},
		{"id": "workflow:unknown", "ghAwVersion": "unknown"},
		{"id": "workflow:placeholder", "name": "Historical workflow"},
	} {
		addCanonicalWorkflow(t, path, workflow)
	}
	original := read(t, path)
	overrides, err := canonicalCompilerOverrides(context.Background(), path, "0.92.0+build")
	if err != nil {
		t.Fatal(err)
	}
	expected := object{
		"workflow:historical":  object{"ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "update-available"},
		"workflow:current":     object{"ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "up-to-date"},
		"workflow:unknown":     object{"ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "unknown"},
		"workflow:placeholder": object{"ghAwCurrentVersion": "v0.92.0"},
	}
	if !reflect.DeepEqual(overrides, expected) {
		t.Fatalf("historical release overrides changed installed evidence or invented state: %#v", overrides)
	}
	if string(read(t, path)) != string(original) {
		t.Fatal("compiler release overlay modified the canonical SQLite snapshot")
	}
	if _, err := canonicalCompilerOverrides(context.Background(), path, "v0.93.0-rc.1"); err == nil {
		t.Fatal("historical comparison accepted an untrusted prerelease as latest stable")
	}
}

func TestArtifactPreparationPublishesPrivateHistoricalCompilerOverrides(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	databasePath := filepath.Join(data, "gh-aw-logs.sqlite")
	addCanonicalWorkflow(t, databasePath, object{
		"id": "workflow:removed", "path": ".github/workflows/removed.md",
		"repositoryId": "repository:octo%2Frepo", "ghAwVersion": "v0.91.5",
	})
	addCanonicalWorkflow(t, databasePath, object{"id": "workflow:placeholder", "name": "Historical workflow"})
	refreshHashes(t, data)
	executable := fakeGH(t, root, trustedArtifact, trustedRun)
	w, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	overrides, _, err := readObject(filepath.Join(w.SourceDirectory, "compiler-overrides.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(overrides["workflow:removed"], object{"ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "update-available"}) ||
		!reflect.DeepEqual(overrides["workflow:placeholder"], object{"ghAwCurrentVersion": "v0.92.0"}) {
		t.Fatalf("historical workflows absent from inventory were not refreshed: %#v", overrides)
	}
	manifest, _, err := readObject(filepath.Join(w.OverlayDirectory, "payload-hashes.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, published := manifest["compiler-overrides.json"]; published {
		t.Fatal("private local compiler overrides were added to the published payload manifest")
	}
}
