package sqlitex

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/internal/dashboardquery"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

func TestOverlayPreservesSnapshotAndPublishesAtomically(t *testing.T) {
	snapshot := testutil.SQLiteSnapshot(t, map[string][]model.Row{
		"repositories": {{"id": "repo:octo/one", "owner": "octo", "name": "one"}},
		"runs":         {{"id": "run:old", "repositoryId": "repo:octo/one", "startedAt": "2026-10-23T00:00:00Z"}},
	})
	before, err := os.ReadFile(snapshot) // #nosec G304 -- test-owned temporary snapshot.
	if err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(t.TempDir(), "local.sqlite")
	store, err := OpenOverlay(t.Context(), snapshot, overlay, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	initial, err := store.State(t.Context())
	if err != nil || initial.Counts["$runs"] != 1 {
		t.Fatalf("initial state: %+v %v", initial, err)
	}
	targets, err := store.BackfillTargets(t.Context(), time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC))
	if err != nil || len(targets) != 1 || targets[0].Repository != "octo/one" ||
		targets[0].Since.Format(time.RFC3339) != "2026-10-22T00:00:00Z" {
		t.Fatalf("bounded refresh scope: %+v %v", targets, err)
	}
	stage := filepath.Join(t.TempDir(), "stage.sqlite")
	if err := store.StageOverlay(t.Context(), stage); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(t.TempDir(), "stale.sqlite")
	if err := store.StageOverlay(t.Context(), stale); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", stage)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES (?,?,?,?)`,
		dashboardquery.DatabaseName, "runs", `"run:new"`, `{"id":"run:new","startedAt":"2026-10-24T00:00:00Z"}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO __cao_overlay_deleted VALUES (?,?,?)`,
		dashboardquery.DatabaseName, "runs", `"run:old"`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if state, err := store.State(t.Context()); err != nil || state.DataRevision != initial.DataRevision {
		t.Fatalf("unpublished staging changed active state: %+v %v", state, err)
	}
	if err := store.PublishOverlay(t.Context(), stage); err != nil {
		t.Fatal(err)
	}
	active, err := store.State(t.Context())
	if err != nil || active.Counts["$runs"] != 1 || active.DataRevision == initial.DataRevision {
		t.Fatalf("published state: %+v %v", active, err)
	}
	if err := store.PublishOverlay(t.Context(), stale); err == nil {
		t.Fatal("stale staging overwrote a concurrent publication")
	}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, source dashboardstore.Reader) error {
		r := source.(*reader)
		rows, err := dashboardquery.ReadCollection(ctx, r.tx, "runs", 10, 10000)
		if err != nil || len(rows) != 1 || rows[0]["id"] != "run:new" {
			t.Fatalf("merged source did not honor tombstones: %v %v", rows, err)
		}
		if _, err := r.tx.ExecContext(ctx, `DELETE FROM snapshot.__idb_records`); err == nil {
			t.Fatal("request connection wrote the snapshot")
		}
		if _, err := r.tx.ExecContext(ctx, `DELETE FROM main.__idb_records`); err == nil {
			t.Fatal("request connection wrote the overlay")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(snapshot) // #nosec G304 -- test-owned temporary snapshot.
	if err != nil || string(after) != string(before) {
		t.Fatal("deployed snapshot bytes changed")
	}
}

func TestOverlayRejectsSnapshotAliasesAndDifferentBases(t *testing.T) {
	snapshot := testutil.SQLiteSnapshot(t, map[string][]model.Row{"repositories": {{"id": "one"}}})
	if _, err := OpenOverlay(t.Context(), snapshot, snapshot, nil); err == nil {
		t.Fatal("accepted snapshot as its own overlay")
	}
	path := filepath.Join(t.TempDir(), "overlay.sqlite")
	store, err := OpenOverlay(t.Context(), snapshot, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	other := testutil.SQLiteSnapshot(t, map[string][]model.Row{"repositories": {{"id": "two"}}})
	if _, err := OpenOverlay(t.Context(), other, path, nil); err == nil || !strings.Contains(err.Error(), "different snapshot") {
		t.Fatalf("accepted overlay with a different base: %v", err)
	}
}

func TestOverlayReadsSurviveRequestCancellation(t *testing.T) {
	snapshot := testutil.SQLiteSnapshot(t, map[string][]model.Row{"repositories": {{"id": "one"}}})
	store, err := OpenOverlay(t.Context(), snapshot, filepath.Join(t.TempDir(), "overlay.sqlite"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	ctx, cancel := context.WithCancel(t.Context())
	err = store.WithReadTransaction(ctx, func(ctx context.Context, r dashboardstore.Reader) error {
		cancel()
		_, err := r.State(ctx)
		return err
	})
	if err == nil {
		t.Fatal("canceled request did not fail")
	}
	if state, err := store.State(t.Context()); err != nil || state.Counts["$repositories"] != 1 {
		t.Fatalf("request cancellation broke future overlay reads: %+v %v", state, err)
	}
}

func TestOverlayUsesProductionCanonicalIngestion(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for canonical ingestion")
	}
	// Initialize the snapshot with the real Node adapter, including all indexes.
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	snapshot := filepath.Join(directory, "snapshot.sqlite")
	// #nosec G204 -- fixed test script and test-owned temporary snapshot.
	init := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `
		import { installSqliteIndexedDB } from './dashboard/site/src/data/storage/sqlite-indexeddb.js';
		import { openCanonicalDatabase } from './dashboard/site/src/data/storage/indexeddb.js';
		const db = await openCanonicalDatabase(installSqliteIndexedDB(process.argv[1]));
		db.close();
	`, snapshot)
	init.Dir = root
	if output, err := init.CombinedOutput(); err != nil {
		t.Fatalf("initialize canonical snapshot: %v\n%s", err, output)
	}
	overlay := filepath.Join(directory, "overlay.sqlite")
	store, err := OpenOverlay(t.Context(), snapshot, overlay, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	stage := filepath.Join(directory, "stage.sqlite")
	if err := store.StageOverlay(t.Context(), stage); err != nil {
		t.Fatal(err)
	}
	logs := filepath.Join(directory, "logs")
	if err := os.Mkdir(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	envelope := map[string]any{
		"schema_version": 2, "kind": "run", "run": map[string]any{
			"organization": "octo", "repository": "one", "run_id": 123, "run_attempt": 1,
			"workflow_name": "test", "workflow_path": ".github/workflows/test.lock.yml",
			"created_at": time.Now().UTC().Format(time.RFC3339), "status": "completed", "conclusion": "success",
		},
	}
	content, _ := json.Marshal(envelope)
	if err := os.WriteFile(filepath.Join(logs, "one.jsonl"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	// #nosec G204 -- fixed runtime script and test-owned temporary evidence.
	command := exec.CommandContext(t.Context(), "node", "activity/local-backfill.mjs",
		stage, snapshot, store.SnapshotRevision(), logs)
	command.Dir = root
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("canonical backfill: %v\n%s", err, output)
	}
	if err := store.PublishOverlay(t.Context(), stage); err != nil {
		t.Fatal(err)
	}
	state, err := store.State(t.Context())
	if err != nil || state.Counts["$runs"] != 1 || state.Counts["$repositories"] != 1 {
		t.Fatalf("canonical rows not published: %+v %v", state, err)
	}
}
