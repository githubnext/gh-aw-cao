package ingest

import (
	"reflect"
	"testing"
)

func TestEmptyPostgresRebuildAndFailedIngestionPreservesCurrentData(t *testing.T) {
	ctx, store := ingestTestStore(t)
	before, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if before.Ready || before.Revision != 0 {
		t.Fatalf("new Postgres schema unexpectedly has data: %+v", before)
	}
	result, err := Run(ctx, store, nil, deployedSubset, Options{
		DatabaseQueriesPath: databaseQueries,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || result.DataRevision == "" || len(result.Counts) == 0 {
		t.Fatalf("empty Postgres schema was not ingested: %+v", result)
	}
	active, err := store.State(ctx)
	if err != nil || !active.Ready || active.Revision != result.Revision || active.DataRevision != result.DataRevision {
		t.Fatalf("ingestion not activated: %+v, %v", active, err)
	}
	original, _, err := store.LoadSource(ctx, "repositories", nil)
	if err != nil || len(original.Rows) == 0 {
		t.Fatalf("expected ingested repositories: %+v, %v", original, err)
	}
	if _, err := Run(ctx, store, nil, scratchDirectory(t), Options{
		DatabaseQueriesPath: databaseQueries,
		Force:               true,
	}); err == nil {
		t.Fatal("expected invalid authoritative source to fail")
	}
	after, err := store.State(ctx)
	if err != nil || !reflect.DeepEqual(after, active) {
		t.Fatalf("failed ingestion replaced current data: before=%+v after=%+v err=%v", active, after, err)
	}
	preserved, _, err := store.LoadSource(ctx, "repositories", nil)
	if err != nil || !reflect.DeepEqual(preserved, original) {
		t.Fatalf("failed ingestion lost current repositories: %+v, %v", preserved, err)
	}
}
