package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNativeDailyCountsSource(t *testing.T) {
	path := nativeTestSnapshot(t, map[string][]map[string]any{
		"dailyRunCounts": {{"id": "daily", "day": "2026-01-02", "owner": "octo", "repository": "api",
			"workflowPath": ".github/workflows/test.md", "total": 3, "successful": 2, "failed": 1, "approval": 0, "pending": 0, "other": 0}},
		"dailyRunCountState": {{"id": "daily-run-counts", "status": "ready"}},
	})
	setup, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := setup.Exec(`CREATE TABLE __idb_stores(database_name TEXT,name TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"dailyRunCounts", "runCountContributions", "dailyRunCountState"} {
		if _, err := setup.Exec(`INSERT INTO __idb_stores VALUES(?,?)`, nativeDatabaseName, name); err != nil {
			t.Fatal(err)
		}
	}
	_ = setup.Close()
	db, err := openNativeSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	catalog, err := loadNativeCatalog("")
	if err != nil {
		t.Fatal(err)
	}
	catalog.index["daily-test"] = map[string]any{"name": "daily-test", "from": "daily-run-counts"}
	result, err := catalog.runQuery(context.Background(), db, "daily-test", nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := result["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["total"] != float64(3) || rows[0]["organization"] != "octo" {
		t.Fatalf("CLI did not read retained counts without detail: %v", result)
	}
	writer, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	for _, test := range []struct {
		name  string
		state map[string]any
		want  map[string]any
	}{
		{"available evidence", map[string]any{"status": "ready", "coverage": "available-evidence-only"},
			map[string]any{"availability": "available", "completeness": "partial", "aggregate-coverage": "available-evidence-only"}},
		{"admitted evidence is not exhaustive history", map[string]any{"status": "ready", "coverage": "admitted"},
			map[string]any{"availability": "available", "completeness": "partial", "aggregate-coverage": "admitted"}},
		{"retained backfill", map[string]any{"status": "ready", "coverage": "retained-v44"},
			map[string]any{"completeness": "partial", "aggregate-coverage": "retained-v44",
				"query-diagnostic": "Backfill covers retained v44 runs only; previously evicted history is unavailable."}},
		{"excluded and conflicted evidence", map[string]any{"status": "ready", "coverage": "admitted", "excludedRuns": 4, "conflictedRuns": 2,
			"retentionCutoff": "2026-01-01", "retentionWatermark": 1767225600000},
			map[string]any{"completeness": "partial", "excluded-runs": float64(4), "conflicted-runs": float64(2),
				"aggregate-retention-start": "2026-01-01", "aggregate-retention-watermark": "2026-01-01T00:00:00.000Z"}},
		{"incomplete backfill", map[string]any{"status": "backfilling", "coverage": "retained-v44"},
			map[string]any{"availability": "unavailable", "completeness": "unknown"}},
		{"invalid retention", map[string]any{"status": "ready", "retentionCutoff": "not-a-date"},
			map[string]any{"availability": "unavailable", "completeness": "unknown"}},
		{"missing state", nil, map[string]any{"availability": "unavailable", "completeness": "unknown"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := writer.Exec(`DELETE FROM __idb_records WHERE store_name='dailyRunCountState'`); err != nil {
				t.Fatal(err)
			}
			if test.state != nil {
				test.state["id"] = "daily-run-counts"
				content, err := json.Marshal(test.state)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := writer.Exec(`INSERT INTO __idb_records VALUES(?, 'dailyRunCountState', '"daily-run-counts"', ?)`,
					nativeDatabaseName, string(content)); err != nil {
					t.Fatal(err)
				}
			}
			result, err := catalog.runQuery(context.Background(), db, "daily-test", nil, 10)
			if err != nil {
				t.Fatal(err)
			}
			metadata := nativeObject(result["metadata"])
			for field, want := range test.want {
				if !reflect.DeepEqual(metadata[field], want) {
					t.Errorf("%s=%v, want %v; metadata=%v", field, metadata[field], want, metadata)
				}
			}
			if metadata["availability"] != "unavailable" {
				if metadata["aggregate-version"] != 1 || metadata["aggregate-time-grain"] != "utc-run-start-day" {
					t.Errorf("aggregate provenance lost: %v", metadata)
				}
			} else if len(result["rows"].([]map[string]any)) != 0 {
				t.Errorf("unavailable aggregate returned rows: %v", result)
			}
		})
	}
	if _, err := writer.Exec(`DELETE FROM __idb_records WHERE store_name IN ('dailyRunCounts', 'dailyRunCountState')`); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(`INSERT INTO __idb_records VALUES(?, 'dailyRunCountState', '"daily-run-counts"',
		'{"id":"daily-run-counts","status":"ready","coverage":"available-evidence-only"}')`, nativeDatabaseName); err != nil {
		t.Fatal(err)
	}
	result, err = catalog.runQuery(context.Background(), db, "daily-test", nil, 10)
	if err != nil || nativeObject(result["metadata"])["availability"] != "empty" ||
		nativeObject(result["metadata"])["completeness"] != "partial" || len(result["rows"].([]map[string]any)) != 0 {
		t.Fatalf("available empty aggregate lost its partial evidence semantics: %v %v", result, err)
	}
	oldPath := nativeTestSnapshot(t, nil)
	old, err := openNativeSnapshot(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = old.Close() }()
	result, err = catalog.runQuery(context.Background(), old, "daily-test", nil, 10)
	if err != nil || nativeObject(result["metadata"])["availability"] != "unavailable" {
		t.Fatalf("old CLI snapshot manufactured daily zeros: %v %v", result, err)
	}
}
