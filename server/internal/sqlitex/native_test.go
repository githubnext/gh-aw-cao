package sqlitex

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
)

func nativeSnapshot(t *testing.T, fixture map[string][]model.Row) string {
	t.Helper()
	path := filepath.Join(testDirectory(t), "gh-aw-logs.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(t.Context(), `CREATE TABLE __idb_records (
		database_name TEXT NOT NULL,store_name TEXT NOT NULL,record_key TEXT NOT NULL,value TEXT NOT NULL,
		PRIMARY KEY(database_name,store_name,record_key))`); err != nil {
		t.Fatal(err)
	}
	for collection, records := range fixture {
		for _, row := range records {
			key, err := json.Marshal(row["id"])
			if err != nil {
				t.Fatal(err)
			}
			content, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES (?,?,?,?)`, databaseName, collection, string(key), string(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	return path
}

func TestDownloadedNativeSnapshotQueriesNeedNoBrowserOrJavaScriptRuntime(t *testing.T) {
	content, err := os.ReadFile("../../../dashboard/site/test/fixtures/canonical-work-items.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string][]model.Row
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, row := range fixture["issues"] {
		row["type"] = "safe_output.result"
	}
	path := nativeSnapshot(t, fixture)
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "inventory-sources.json"), []byte(`{
		"configuration-policy":{"rows":[{"mode":"review"}],"metadata":{"availability":"available","completeness":"complete","freshness":"fresh","as-of":"2026-10-18T10:00:00Z"}},
		"tools":{"rows":[],"metadata":{"availability":"unavailable","error":"record phase is missing"}}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path) //nolint:gosec // G304: path is the SQLite fixture created by nativeSnapshot in this test's private directory.
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	state, err := store.State(t.Context())
	if err != nil || !state.Ready || state.Revision <= 0 || state.DataRevision == "" || state.EvaluatedAt.IsZero() {
		t.Fatalf("native state: %#v %v", state, err)
	}
	defs := canonicalDefinitions(t)
	names := make([]string, 0, len(defs)+1)
	for _, def := range defs {
		names = append(names, def.Name)
	}
	names = append(names, "configuration-policy")
	result, _, err := store.ExecuteSQLPlan(t.Context(), defs, names)
	if err != nil {
		t.Fatal(err)
	}
	if len(result["work-items"].Rows) != 2 || len(result["outcomes"].Rows) != 2 {
		t.Fatalf("native canonical relationships changed: work-items=%d outcomes=%d", len(result["work-items"].Rows), len(result["outcomes"].Rows))
	}
	if result["tools"].Metadata["availability"] != "unavailable" || result["configuration-policy"].Metadata["completeness"] != "complete" {
		t.Fatalf("native source availability was not preserved: %#v %#v", result["tools"], result["configuration-policy"])
	}
	diagnostics, err := store.Diagnostics(t.Context())
	if err != nil || diagnostics.Counts["runs"] != 2 || len(diagnostics.RelationshipErrors) != 0 {
		t.Fatalf("native diagnostics: %#v %v", diagnostics, err)
	}
	if _, err := store.db.ExecContext(t.Context(), `DELETE FROM __idb_records`); err == nil {
		t.Fatal("verified native snapshot was opened writable")
	}
	reopened, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := reopened.State(t.Context())
	_ = reopened.Close()
	if err != nil || recovered.Revision != state.Revision || recovered.DataRevision != state.DataRevision || !recovered.EvaluatedAt.Equal(state.EvaluatedAt) {
		t.Fatalf("native revision is not recoverable: %#v %#v %v", state, recovered, err)
	}
	expected := postgresx.State{Revision: 7, EvaluatedAt: time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)}
	if err := store.SetState(t.Context(), expected); err != nil {
		t.Fatal(err)
	}
	reopened, err = Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err = reopened.State(t.Context())
	_ = reopened.Close()
	if err != nil || recovered.Revision != 7 || !recovered.EvaluatedAt.Equal(expected.EvaluatedAt) || !recovered.Ready {
		t.Fatalf("explicit native revision was not persisted: %#v %v", recovered, err)
	}
	after, err := os.ReadFile(path) //nolint:gosec // G304: path is the same test-owned SQLite fixture read before serving.
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("serving changed the verified downloaded snapshot")
	}
}

func TestNativeIndexedDBKeysAndQuality(t *testing.T) {
	path := nativeSnapshot(t, map[string][]model.Row{
		"transactions": {{"id": 10}, {"id": 2}, {"id": 1}},
		"runs":         {{"id": "\ue000"}, {"id": "\U00010000"}, {"id": "a"}},
		"quality":      {{"id": "tools", "metadata": map[string]any{"availability": "unavailable", "error": "not collected"}}},
	})
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	result, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"$transactions", "$runs", "$campaigns", "$tools"})
	if err != nil {
		t.Fatal(err)
	}
	for collection, ids := range map[string][]any{
		"$transactions": {1, 2, 10},
		"$runs":         {"a", "\U00010000", "\ue000"},
	} {
		var actual []any
		for _, row := range result[collection].Rows {
			actual = append(actual, row["id"])
		}
		equalJSON(t, actual, ids)
	}
	if result["$campaigns"].Metadata["availability"] != "empty" || result["$tools"].Metadata["availability"] != "unavailable" {
		t.Fatal("missing rows were confused with explicitly unavailable evidence")
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"not-registered"}); err == nil {
		t.Fatal("unknown native logical source was admitted")
	}
}

func TestNativeMemoryAndUninitializedSnapshot(t *testing.T) {
	path := nativeSnapshot(t, nil)
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.State(t.Context())
	if err != nil || state.Ready {
		t.Fatalf("uninitialized snapshot became ready: %#v %v", state, err)
	}
	result, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"$runs", "repository-memory-files"})
	if err != nil || result["$runs"].Metadata["availability"] != "unavailable" || result["repository-memory-files"].Metadata["availability"] != "unavailable" {
		t.Fatalf("uninitialized data became successful empty: %#v %v", result, err)
	}
	_ = store.Close()
	directory := filepath.Dir(path)
	if err := os.MkdirAll(filepath.Join(directory, "memory", "dashboard"), 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("native memory\n")
	digest := sha256.Sum256(payload)
	manifest := map[string]any{"version": 1, "campaigns": []any{map[string]any{
		"campaign": "dashboard", "branch": "memory/dashboard", "commit": strings.Repeat("a", 40),
		"files": []any{map[string]any{"path": "notes.md", "oid": strings.Repeat("b", 40), "size": len(payload), "sha256": hex.EncodeToString(digest[:])}},
	}}}
	content, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(directory, "memory", "manifest.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "memory", "dashboard", "notes.md"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	result, _, err = store.ExecuteSQLPlan(t.Context(), nil, []string{"repository-memory-manifest", "$repositoryMemoryFiles"})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, result["$repositoryMemoryFiles"].Rows, []model.Row{{"campaign": "dashboard", "path": "notes.md", "content": string(payload), "size": len(payload)}})
	if result["repository-memory-manifest"].Metadata["completeness"] != "complete" {
		t.Fatal("validated native memory metadata was lost")
	}
}
