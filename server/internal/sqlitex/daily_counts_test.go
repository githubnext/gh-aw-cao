package sqlitex

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"
	"time"

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
		if source.Metadata["retention"] != "all-admitted-dated-observations" ||
			source.Metadata["aggregate-retention-start"] != nil || source.Metadata["aggregate-retention-watermark"] != nil {
			t.Fatalf("legacy snapshot claimed bounded retention: %+v", source.Metadata)
		}
		_, err = dashboardquery.ReadCollection(ctx, r.(*reader).tx, "runs", 10, 1000)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	watermark := time.Date(2026, 1, 2, 3, 4, 5, 123000000, time.UTC)
	if _, err := db.ExecContext(t.Context(), `UPDATE __idb_records
		SET value=json_set(value,'$.retentionCutoff','2025-12-15','$.retentionWatermark',?)
		WHERE store_name='dailyRunCountState'`, watermark.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		sources, _, err := r.ExecuteSQLPlan(ctx, []query.Definition{
			{Name: "daily", From: "daily-run-counts"}, {Name: "raw", From: "$dailyRunCounts"},
		}, []string{"daily", "raw"})
		if err != nil {
			return err
		}
		for _, name := range []string{"daily", "raw"} {
			metadata := sources[name].Metadata
			if metadata["retention"] != "three-utc-calendar-weeks" || metadata["aggregate-retention-start"] != "2025-12-15" ||
				metadata["aggregate-retention-watermark"] != watermark.Format(time.RFC3339Nano) {
				t.Fatalf("%s snapshot lost persisted retention provenance: %+v", name, metadata)
			}
			if len(sources[name].Rows) != 1 || sources[name].Rows[0]["total"] != float64(7) {
				t.Fatalf("retention metadata changed snapshot counts: %+v", sources[name])
			}
		}
		return nil
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

func TestRepositoryRunInventoryDailyAvailability(t *testing.T) {
	var definitions []query.Definition
	for _, path := range []string{
		"../../../dashboard/site/src/data/queries/database.json",
		"../../../dashboard/site/src/agent/queries.generated.json",
	} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var batch []query.Definition
		if err := json.Unmarshal(content, &batch); err != nil {
			t.Fatal(err)
		}
		definitions = append(definitions, batch...)
	}
	for _, status := range []string{"absent", "backfilling", "ready", "empty"} {
		t.Run(status, func(t *testing.T) {
			path := testutil.SQLiteSnapshot(t, map[string][]model.Row{
				"repositories": {{"id": "repo", "owner": "octo", "name": "api"}},
			})
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"dailyRunCounts", "runCountContributions", "dailyRunCountState"} {
				if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_stores VALUES(?,?,'id')`, dashboardquery.DatabaseName, name); err != nil {
					t.Fatal(err)
				}
			}
			records := map[string]model.Row{}
			if status != "absent" {
				ready := status
				if status == "empty" {
					ready = "ready"
				}
				records["dailyRunCountState"] = model.Row{"id": "daily-run-counts", "status": ready, "coverage": "retained-v44", "retentionCutoff": "2026-10-05"}
			}
			if status != "empty" {
				records["dailyRunCounts"] = model.Row{"id": "daily", "day": "2026-10-20", "repositoryId": "repo", "workflowId": "workflow",
					"owner": "octo", "repository": "api", "workflowPath": ".github/workflows/test.md",
					"total": 7, "successful": 7, "failed": 0, "approval": 0, "pending": 0, "other": 0}
			}
			for name, record := range records {
				key, _ := json.Marshal(record["id"])
				content, _ := json.Marshal(record)
				if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES(?,?,?,?)`, dashboardquery.DatabaseName, name, string(key), string(content)); err != nil {
					t.Fatal(err)
				}
			}
			_ = db.Close()
			store, err := Open(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = store.Close() }()
			if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
				sources, _, err := r.ExecuteSQLPlan(ctx, definitions, []string{"repository-run-inventory"})
				if err != nil {
					return err
				}
				source := sources["repository-run-inventory"]
				if status == "absent" || status == "backfilling" {
					if len(source.Rows) != 0 || source.Metadata["availability"] != "unavailable" {
						t.Fatalf("unavailable daily evidence fabricated inventory zeros: %+v", source)
					}
				} else {
					want := float64(7)
					if status == "empty" {
						want = 0
					}
					if len(source.Rows) != 1 || source.Rows[0]["runs"] != want || source.Metadata["completeness"] != "partial" ||
						source.Metadata["aggregate-retention-start"] != "2026-10-05" {
						t.Fatalf("daily inventory lost counts or coverage: %+v", source)
					}
				}
				if source.Metadata["aggregate-version"] != 1 {
					t.Fatalf("inventory lost aggregate identity: %+v", source.Metadata)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
