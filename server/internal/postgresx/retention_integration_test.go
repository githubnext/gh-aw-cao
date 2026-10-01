package postgresx

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestPruneSnapshotsKeepsRecentAndActiveSnapshots(t *testing.T) {
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

	prefix := fmt.Sprintf("postgres-retention-%d", time.Now().UnixNano())
	ids := make([]string, 4)
	for index := range ids {
		ids[index] = fmt.Sprintf("%s-%d", prefix, index)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = store.pool.Exec(cleanupCtx,
			"DELETE FROM cao_active_projection WHERE snapshot_id = ANY($1)", ids)
		for _, id := range ids {
			_ = store.DeleteSnapshot(cleanupCtx, id)
		}
	})

	for index, id := range ids {
		if err := store.BeginSnapshot(ctx, id); err != nil {
			t.Fatal(err)
		}
		if err := store.WriteSource(ctx, id, model.Source{
			Source: "runs", Metadata: model.Metadata{}, Rows: []model.Row{},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ActivateSnapshot(ctx, id, id, time.Now().UTC(), map[string]int{"runs": 0}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.pool.Exec(ctx,
			"UPDATE cao_projection_snapshots SET activated_at = clock_timestamp() - ($2 * interval '1 hour') WHERE snapshot_id = $1",
			id, len(ids)-index); err != nil {
			t.Fatal(err)
		}
	}

	dropped, err := store.PruneSnapshots(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 2 {
		t.Fatalf("pruned %d snapshots, want 2", dropped)
	}
	active, err := store.ActiveSnapshot(ctx)
	if err != nil || active.ID != ids[len(ids)-1] {
		t.Fatalf("cleanup changed the active snapshot: %+v %v", active, err)
	}
	sources, err := store.Sources(ctx, ids[0])
	if err != nil || len(sources) != 0 {
		t.Fatalf("old snapshot was not reclaimed: sources=%v err=%v", sources, err)
	}
}
