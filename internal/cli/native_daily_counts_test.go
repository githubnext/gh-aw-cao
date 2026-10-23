package cli

import (
	"context"
	"database/sql"
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
