package cli

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

func TestNativeRepositoryRunInventoryDailyAvailability(t *testing.T) {
	for _, test := range []struct {
		name       string
		stores     bool
		state      map[string]any
		diagnostic string
	}{
		{"absent stores", false, nil, "Daily run counts are not available"},
		{"missing state", true, nil, "Daily run counts are not available"},
		{"backfilling", true, map[string]any{"status": "backfilling"}, "Daily run counts are not available"},
		{"invalid retention", true, map[string]any{"status": "ready", "retentionCutoff": "not-a-date"}, "daily run count retention cutoff"},
		{"ready", true, map[string]any{"status": "ready", "coverage": "available-evidence-only"}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			batch := map[string][]map[string]any{
				"repositories": {{"id": "repository:octo/api", "owner": "octo", "name": "api"}},
				"dailyRunCounts": {{"id": "daily", "day": "2026-01-02", "owner": "octo", "repository": "api",
					"workflowPath": ".github/workflows/test.md", "total": 3, "successful": 2, "failed": 1, "approval": 0, "pending": 0, "other": 0}},
			}
			if test.state != nil {
				test.state["id"] = "daily-run-counts"
				batch["dailyRunCountState"] = []map[string]any{test.state}
			}
			path := nativeTestSnapshot(t, batch)
			setup, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = setup.Close() }()
			if _, err := setup.Exec(`CREATE TABLE __idb_stores(database_name TEXT,name TEXT)`); err != nil {
				t.Fatal(err)
			}
			if test.stores {
				for _, name := range []string{"dailyRunCounts", "runCountContributions", "dailyRunCountState"} {
					if _, err := setup.Exec(`INSERT INTO __idb_stores VALUES(?,?)`, nativeDatabaseName, name); err != nil {
						t.Fatal(err)
					}
				}
			}
			db, err := openNativeSnapshot(path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = db.Close() }()
			catalog, err := loadNativeCatalog("")
			if err != nil {
				t.Fatal(err)
			}
			result, err := catalog.runQuery(context.Background(), db, "repository-run-inventory", nil, 10)
			if err != nil {
				t.Fatal(err)
			}
			rows := result["rows"].([]map[string]any)
			metadata := nativeObject(result["metadata"])
			if test.diagnostic != "" {
				if metadata["availability"] != "unavailable" || len(rows) != 0 ||
					!strings.Contains(nativeText(metadata["query-diagnostic"]), test.diagnostic) {
					t.Fatalf("daily left join manufactured counts or lost its diagnostic: %v", result)
				}
			} else if metadata["availability"] != "available" || len(rows) != 1 || rows[0]["runs"] != float64(3) {
				t.Fatalf("ready daily left join did not preserve observed counts: %v", result)
			}

			catalog.index["optional-broken"] = map[string]any{"name": "optional-broken", "from": "runs",
				"compute": []any{map[string]any{"as": "invalid", "function": "not-a-function"}}}
			result, err = catalog.runQuery(context.Background(), db, "optional-broken", nil, 10)
			if err != nil || nativeObject(result["metadata"])["availability"] != "unavailable" {
				t.Fatalf("optional join fixture did not fail upstream: %v %v", result, err)
			}
			catalog.index["optional-test"] = map[string]any{"name": "optional-test", "from": "repositories",
				"joins": []any{map[string]any{"source": "optional-broken", "type": "left",
					"on":     []any{map[string]any{"left": "id", "right": "id"}},
					"fields": []any{map[string]any{"field": "id", "as": "optional-id"}}}}}
			result, err = catalog.runQuery(context.Background(), db, "optional-test", nil, 10)
			if err != nil || nativeObject(result["metadata"])["availability"] != "available" ||
				len(result["rows"].([]map[string]any)) != 1 {
				t.Fatalf("ordinary optional left-join failure became fatal: %v %v", result, err)
			}
		})
	}
}
