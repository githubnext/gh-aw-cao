package postgresx

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestSnapshotLifecyclePreservesUnknownSourceProperties(t *testing.T) {
	connectionString := os.Getenv("POSTGRES_URL")
	if connectionString == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, err := New(ctx, connectionString, Options{MaxConns: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)

	snapshotID := "postgres-integration-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = store.pool.Exec(cleanupCtx,
			"DELETE FROM cao_active_projection WHERE snapshot_id = $1", snapshotID)
		_ = store.DeleteSnapshot(cleanupCtx, snapshotID)
	})
	if err := store.BeginSnapshot(ctx, snapshotID); err != nil {
		t.Fatal(err)
	}
	source := model.Source{
		Source: "integration-runs",
		Metadata: model.Metadata{
			"availability": "available",
		},
		Rows: []model.Row{{
			"id": "run-1", "future-field": map[string]any{"nested": true},
		}},
	}
	if err := store.WriteSource(ctx, snapshotID, source); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateSnapshot(ctx, snapshotID, map[string]int{"integration-runs": 2}); err == nil {
		t.Fatal("snapshot with a mismatched source count validated")
	}
	if err := store.ValidateSnapshot(ctx, snapshotID, map[string]int{"integration-runs": 1}); err != nil {
		t.Fatal(err)
	}
	active, err := store.ActivateSnapshot(ctx, snapshotID, "sha256:test", time.Now().UTC(), map[string]int{"integration-runs": 1})
	if err != nil {
		t.Fatal(err)
	}
	if active.ID != snapshotID || active.Revision != 1 {
		t.Fatalf("unexpected activated snapshot: %+v", active)
	}
	reopened, err := New(ctx, connectionString, Options{MaxConns: 2})
	if err != nil {
		t.Fatalf("repeated schema initialization failed: %v", err)
	}
	reopened.Close()
	if err := store.DeleteSnapshot(ctx, snapshotID); err == nil {
		t.Fatal("active snapshot was deleted")
	}
	failedID := snapshotID + "-failed"
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = store.DeleteSnapshot(cleanupCtx, failedID)
	})
	if err := store.BeginSnapshot(ctx, failedID); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteSource(ctx, failedID, model.Source{
		Source: "integration-runs",
		Rows:   []model.Row{{"id": "run-2"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ActivateSnapshot(ctx, failedID, "sha256:failed", time.Now().UTC(),
		map[string]int{"integration-runs": 2}); err == nil {
		t.Fatal("snapshot with a mismatched source count activated")
	}
	stillActive, err := store.ActiveSnapshot(ctx)
	if err != nil || stillActive.ID != snapshotID {
		t.Fatalf("failed activation changed active snapshot: %+v %v", stillActive, err)
	}
	if err := store.DeleteSnapshot(ctx, failedID); err != nil {
		t.Fatalf("failed snapshot cleanup: %v", err)
	}
	loaded, err := store.Source(ctx, snapshotID, source.Source)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Rows) != 1 {
		t.Fatalf("got %d source rows, want one", len(loaded.Rows))
	}
	future, ok := loaded.Rows[0]["future-field"].(map[string]any)
	if !ok || future["nested"] != true {
		t.Fatalf("unknown source properties were not preserved: %#v", loaded.Rows[0])
	}
	result, metrics, err := store.ExecutePlan(
		ctx, snapshotID,
		[]query.Definition{{Name: "all-runs", From: source.Source}},
		[]string{"all-runs"}, nil, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(result["all-runs"].Rows) != 1 || metrics.PushedDown[0] != "postgres" {
		t.Fatalf("unexpected PostgreSQL source query: result=%#v metrics=%+v", result, metrics)
	}
}
