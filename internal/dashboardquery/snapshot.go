package dashboardquery

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"unicode/utf16"
)

const DatabaseName = "gh-aw-cao-dashboard-data"
const DatabaseVersion = 42

// SnapshotReader accepts a database or an already pinned read transaction.
type SnapshotReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// ReadCollection preserves canonical IndexedDB key order and omits storage-only
// fields. Positive limits bound allocation before materializing a collection.
func ReadCollection(ctx context.Context, db SnapshotReader, collection string, maxRows int, maxBytes int64) (result []map[string]any, err error) {
	rows, err := db.QueryContext(ctx, `SELECT record_key, value FROM __idb_records WHERE database_name=? AND store_name=?`, DatabaseName, collection)
	if err != nil {
		return nil, fmt.Errorf("read canonical %s: %w", collection, err)
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	type entry struct {
		key    any
		record map[string]any
	}
	entries := []entry{}
	var bytes int64
	for rows.Next() {
		var keyJSON, content string
		if err := rows.Scan(&keyJSON, &content); err != nil {
			return nil, err
		}
		bytes += int64(len(keyJSON) + len(content))
		if maxRows > 0 && len(entries) >= maxRows || maxBytes > 0 && bytes > maxBytes {
			return nil, fmt.Errorf("canonical %s exceeds local query input budget", collection)
		}
		var key any
		if err := json.Unmarshal([]byte(keyJSON), &key); err != nil || !ValidRecordKey(key) {
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
	slices.SortFunc(entries, func(left, right entry) int { return CompareRecordKeys(left.key, right.key) })
	result = make([]map[string]any, len(entries))
	for index, entry := range entries {
		result[index] = entry.record
	}
	return result, rows.Err()
}

func ValidRecordKey(key any) bool {
	switch key := key.(type) {
	case float64, string:
		return true
	case []any:
		for _, part := range key {
			if !ValidRecordKey(part) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func CompareRecordKeys(left, right any) int {
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
		return slices.CompareFunc(left.([]any), right.([]any), CompareRecordKeys)
	}
}
