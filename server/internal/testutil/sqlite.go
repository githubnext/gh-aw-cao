package testutil

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/githubnext/gh-cao/internal/dashboardquery"

	"github.com/githubnext/gh-cao/server/internal/model"
)

// SQLiteSnapshot writes the same canonical records layout as cao download.
func SQLiteSnapshot(t testing.TB, sources map[string][]model.Row) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "snapshot.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := db.ExecContext(t.Context(), `
		PRAGMA journal_mode=WAL;
		CREATE TABLE __idb_databases(name TEXT PRIMARY KEY, version INTEGER NOT NULL);
		CREATE TABLE __idb_stores(database_name TEXT NOT NULL,name TEXT NOT NULL,key_path TEXT NOT NULL,
			PRIMARY KEY(database_name,name));
		CREATE TABLE __idb_records(database_name TEXT NOT NULL,store_name TEXT NOT NULL,
			record_key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(database_name,store_name,record_key));
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_databases VALUES (?,?)`, dashboardquery.DatabaseName, dashboardquery.DatabaseVersion); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"campaigns", "repositories", "workflows", "runs", "domains", "tools", "skills", "friction", "audits", "issues",
		"operationalValues", "operationalValueEvidence", "marketplacePackages", "experiments", "experimentAssignments", "graders", "graderObservations",
		"evals", "evalObservations", "transactions", "daily_workflow_aggregates", "daily_workflow_contributions",
	} {
		if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_stores VALUES (?,?,'id')`, dashboardquery.DatabaseName, name); err != nil {
			t.Fatal(err)
		}
		for _, row := range sources[name] {
			key, err := json.Marshal(row["id"])
			if err != nil {
				t.Fatal(err)
			}
			value, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES (?,?,?,?)`,
				dashboardquery.DatabaseName, name, string(key), string(value)); err != nil {
				t.Fatal(err)
			}
		}
	}
	return path
}
