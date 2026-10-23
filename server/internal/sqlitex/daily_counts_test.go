package sqlitex

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"

	"github.com/githubnext/gh-cao/internal/dashboardquery"
	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

func TestDailyCountsSnapshotSourceWithoutDetail(t *testing.T) {
	path := testutil.SQLiteSnapshot(t, nil)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"dailyRunCounts", "runCountContributions", "dailyRunCountState"} {
		if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_stores VALUES(?,?,'id')`, dashboardquery.DatabaseName, name); err != nil {
			t.Fatal(err)
		}
	}
	counts := model.Row{"id": `["2026-01-02","repo","workflow"]`, "day": "2026-01-02", "repositoryId": "repo", "workflowId": "workflow",
		"owner": "octo", "repository": "api", "workflowPath": ".github/workflows/test.md",
		"total": 7, "successful": 2, "failed": 1, "approval": 1, "pending": 2, "other": 1}
	for store, records := range map[string][]model.Row{
		"dailyRunCounts":        {counts},
		"runCountContributions": {{"id": "undated", "run": model.Row{"id": "undated"}}},
		"dailyRunCountState":    {{"id": "daily-run-counts", "status": "ready", "coverage": "admitted"}},
	} {
		for _, record := range records {
			key, _ := json.Marshal(record["id"])
			content, _ := json.Marshal(record)
			if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES(?,?,?,?)`, dashboardquery.DatabaseName, store, string(key), string(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	content, err := os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	definitions = append(definitions, query.Definition{Name: "daily", From: "daily-run-counts"})
	if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		sources, _, err := r.ExecuteSQLPlan(ctx, definitions, []string{"daily"})
		if err != nil {
			return err
		}
		source := sources["daily"]
		if len(source.Rows) != 1 || source.Rows[0]["total"] != float64(7) || source.Rows[0]["organization"] != "octo" ||
			source.Rows[0]["workflow"] != ".github/workflows/test.md" || source.Metadata["undated-run-count"] != int64(1) {
			t.Fatalf("daily source lost aggregate rows: %+v", source)
		}
		_, err = dashboardquery.ReadCollection(ctx, r.(*reader).tx, "runs", 10, 1000)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `UPDATE __idb_records SET value=json_set(value,'$.status','backfilling')
		WHERE store_name='dailyRunCountState'`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	after, err := store.State(t.Context())
	if err != nil || before.DataRevision == after.DataRevision {
		t.Fatalf("daily state changes did not invalidate snapshot revision: %v", err)
	}
	if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		sources, _, err := r.ExecuteSQLPlan(ctx, []query.Definition{{Name: "daily", From: "daily-run-counts"}}, []string{"daily"})
		if err == nil && sources["daily"].Metadata["availability"] != "unavailable" {
			t.Fatal("partially backfilled history became available")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDailyCountsOldSnapshotUnavailable(t *testing.T) {
	path := testutil.SQLiteSnapshot(t, nil)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `UPDATE __idb_databases SET version=44`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		sources, _, err := r.ExecuteSQLPlan(ctx, []query.Definition{{Name: "daily", From: "daily-run-counts"}}, []string{"daily"})
		if err != nil {
			return err
		}
		if sources["daily"].Metadata["availability"] != "unavailable" || len(sources["daily"].Rows) != 0 {
			t.Fatalf("old snapshot manufactured zeros: %+v", sources["daily"])
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
