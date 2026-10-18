package cli

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/spf13/cobra"
	_ "modernc.org/sqlite"
)

const nativeDatabasePath = ".cao/gh-aw-logs.sqlite"
const nativeDatabaseName = "gh-aw-cao-dashboard-data"

var nativeCollections = []string{
	"repositories", "workflows", "runs", "domains", "tools", "skills", "friction", "audits", "issues",
	"operationalValues", "experiments", "experimentAssignments", "graders", "graderObservations", "evals", "evalObservations", "transactions",
}

func nativeString(cmd *cobra.Command, name string) string {
	value, _ := cmd.Flags().GetString(name)
	return value
}

func nativeBool(cmd *cobra.Command, name string) bool {
	value, _ := cmd.Flags().GetBool(name)
	return value
}

func nativeStrings(cmd *cobra.Command, name string) []string {
	value, _ := cmd.Flags().GetStringArray(name)
	return value
}

func nativeSnapshotPath(cmd *cobra.Command) string {
	if value := nativeString(cmd, "database"); value != "" {
		return value
	}
	return nativeDatabasePath
}

func openNativeSnapshot(path string) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absolute)
	if errors.Is(err, os.ErrNotExist) {
		db, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		if _, err := db.Exec(`CREATE TABLE __idb_records (database_name TEXT, store_name TEXT, record_key TEXT, value TEXT)`); err != nil {
			return nil, errors.Join(err, db.Close())
		}
		return db, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nativeErrorf("CAO snapshot is not a regular file: %s", path)
	}
	location := &url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}
	query := location.Query()
	query.Set("mode", "ro")
	query.Set("_pragma", "busy_timeout(5000)")
	location.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", location.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='__idb_records'`).Scan(&count); err != nil {
		return nil, errors.Join(fmt.Errorf("read CAO snapshot: %w", err), db.Close())
	}
	if count != 1 {
		return nil, errors.Join(nativeErrorf("CAO snapshot has no canonical records table: %s", path), db.Close())
	}
	return db, nil
}

func readNativeCollection(ctx context.Context, db *sql.DB, collection string) (result []map[string]any, err error) {
	if !slices.Contains(nativeCollections, collection) && collection != "campaigns" && collection != "marketplacePackages" {
		return nil, nativeErrorf("Unknown collection: %s", collection)
	}
	rows, err := db.QueryContext(ctx, `SELECT record_key, value FROM __idb_records WHERE database_name=? AND store_name=?`, nativeDatabaseName, collection)
	if err != nil {
		return nil, fmt.Errorf("read canonical %s: %w", collection, err)
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	type entry struct {
		key    any
		record map[string]any
	}
	entries := []entry{}
	for rows.Next() {
		var keyJSON, content string
		if err := rows.Scan(&keyJSON, &content); err != nil {
			return nil, err
		}
		var key any
		if err := json.Unmarshal([]byte(keyJSON), &key); err != nil || !nativeRecordKeyValid(key) {
			return nil, fmt.Errorf("invalid canonical %s record key", collection)
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(content), &record); err != nil || record == nil {
			return nil, fmt.Errorf("invalid canonical %s record JSON", collection)
		}
		if collection != "transactions" {
			delete(record, "_queryKeys")
			delete(record, "_storage")
		}
		entries = append(entries, entry{key: key, record: record})
	}
	slices.SortFunc(entries, func(left, right entry) int { return nativeCompareRecordKeys(left.key, right.key) })
	result = make([]map[string]any, len(entries))
	for index, entry := range entries {
		result[index] = entry.record
	}
	return result, rows.Err()
}

func nativeRecordKeyValid(key any) bool {
	switch key := key.(type) {
	case float64, string:
		return true
	case []any:
		for _, part := range key {
			if !nativeRecordKeyValid(part) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func nativeCompareRecordKeys(left, right any) int {
	rank := func(key any) int {
		switch key.(type) {
		case float64:
			return 1
		case string:
			return 3
		default:
			return 4
		}
	}
	if difference := rank(left) - rank(right); difference != 0 {
		return difference
	}
	switch left := left.(type) {
	case float64:
		return cmp.Compare(left, right.(float64))
	case string:
		return slices.Compare(utf16.Encode([]rune(left)), utf16.Encode([]rune(right.(string))))
	default:
		return slices.CompareFunc(left.([]any), right.([]any), nativeCompareRecordKeys)
	}
}

func requireNativeSnapshot(cmd *cobra.Command, named bool) error {
	if cmd.Flags().Changed("database") {
		return nil
	}
	path := nativeSnapshotPath(cmd)
	_, err := os.Stat(path)
	if err == nil && named {
		_, err = os.Stat(filepath.Join(filepath.Dir(path), "payload-hashes.json"))
	}
	if errors.Is(err, os.ErrNotExist) {
		return nativeErrorf("No downloaded CAO snapshot at %s; run cao download before querying, or pass --database FILE for an explicitly prepared database", path)
	}
	return err
}

func nativeLimit(cmd *cobra.Command, fallback int) (int, error) {
	value := nativeString(cmd, "limit")
	if value == "" && !cmd.Flags().Changed("limit") {
		return fallback, nil
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		return 0, fmt.Errorf("--limit must be a positive integer")
	}
	return number, nil
}

func nativeField(record map[string]any, field string) any {
	value, _ := nativeFieldLookup(record, field)
	return value
}

func nativeFieldLookup(record map[string]any, field string) (any, bool) {
	var value any = record
	for _, part := range strings.Split(field, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return value, true
}

func nativeScalar(value any) string {
	return engineJSString(value)
}
