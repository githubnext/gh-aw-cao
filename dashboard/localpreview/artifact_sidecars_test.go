package localpreview

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestNativeSnapshotPreservesCanonicalRecordsAndMemorySidecars(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	database, err := sql.Open("sqlite", filepath.Join(data, "gh-aw-logs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO __idb_records VALUES ('gh-aw-cao-dashboard-data','repositories','"repository:acme%2Fone"','{"id":"repository:acme%2Fone","name":"one"}')`,
		`INSERT INTO __idb_records VALUES ('gh-aw-cao-dashboard-data','repositories','"repository:acme%2Ftwo"','{"id":"repository:acme%2Ftwo","name":"two"}')`,
	} {
		if _, err := database.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	refreshHashes(t, data)
	write(t, data, "memory/manifest.json", `{"version":1,"campaigns":[{"campaign":"dashboard","files":[{"path":"notes.md"}]}]}`)
	write(t, data, "memory/dashboard/notes.md", "bounded memory\n")
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	database, err = sql.Open("sqlite", w.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM __idb_records WHERE store_name='repositories'`).Scan(&count); err != nil || count != 2 {
		t.Fatal("preparation dropped records from the native canonical snapshot")
	}
	if string(read(t, filepath.Join(w.SourceDirectory, "memory/dashboard/notes.md"))) != "bounded memory\n" ||
		string(read(t, filepath.Join(w.SourceDirectory, "memory/manifest.json"))) != string(read(t, filepath.Join(data, "memory/manifest.json"))) {
		t.Fatal("canonical repository memory sidecars were not retained")
	}
}
