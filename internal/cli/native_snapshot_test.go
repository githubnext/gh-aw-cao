package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func nativeTestSnapshot(t *testing.T, collections map[string][]map[string]any) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "snapshot.sqlite")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.Exec(`CREATE TABLE __idb_records (database_name TEXT NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(database_name,store_name,record_key))`); err != nil {
		t.Fatal(err)
	}
	for collection, records := range collections {
		for _, record := range records {
			content, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			key, err := json.Marshal(record["id"])
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO __idb_records VALUES (?,?,?,?)`, nativeDatabaseName, collection, string(key), string(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	return file
}

func TestNativeSnapshotIsReadOnly(t *testing.T) {
	file := nativeTestSnapshot(t, map[string][]map[string]any{"runs": {
		{"id": "b", "status": "completed", "_queryKeys": map[string]any{"private": "key"}, "_storage": "private"},
		{"id": "a", "conclusion": "failure"},
	}})
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	db, err := openNativeSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	rows, err := readNativeCollection(context.Background(), db, "runs")
	if err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{{"id": "a", "conclusion": "failure"}, {"id": "b", "status": "completed"}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows=%v, want %v", rows, want)
	}
	if _, err := db.Exec(`DELETE FROM __idb_records`); err == nil {
		t.Fatal("snapshot was opened writable")
	}
	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("query changed the snapshot bytes")
	}
}

func TestNativeExplicitMissingSnapshotDoesNotWrite(t *testing.T) {
	file := filepath.Join(t.TempDir(), "missing.sqlite")
	db, err := openNativeSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	rows, err := readNativeCollection(context.Background(), db, "runs")
	if err != nil || len(rows) != 0 {
		t.Fatalf("empty explicit snapshot=%v, %v", rows, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("read-only query created a snapshot: %v", err)
	}
}

func TestNativeSnapshotPreservesIndexedDBKeyOrder(t *testing.T) {
	file := nativeTestSnapshot(t, map[string][]map[string]any{
		"transactions": {{"id": 10}, {"id": 2}, {"id": 1}},
		"runs":         {{"id": "\ue000"}, {"id": "\U00010000"}, {"id": "a"}},
	})
	db, err := openNativeSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	for collection, expected := range map[string][]any{
		"transactions": {float64(1), float64(2), float64(10)},
		"runs":         {"a", "\U00010000", "\ue000"},
	} {
		rows, err := readNativeCollection(context.Background(), db, collection)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != len(expected) {
			t.Fatalf("%s returned %d records, want %d", collection, len(rows), len(expected))
		}
		for index, row := range rows {
			if row["id"] != expected[index] {
				t.Fatalf("%s key %d=%v, want %v", collection, index, row["id"], expected[index])
			}
		}
	}
}
