package dashboardquery

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

const DatabaseName = "gh-aw-cao-dashboard-data"
const DatabaseVersion = 45

// SnapshotReader accepts a database or an already pinned read transaction.
type SnapshotReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// ReadCollection preserves canonical IndexedDB key order and omits storage-only
// fields. Positive limits bound allocation before materializing a collection.
func ReadCollection(ctx context.Context, db SnapshotReader, collection string, maxRows int, maxBytes int64) (result []map[string]any, err error) {
	return ReadCollectionFields(ctx, db, collection, nil, maxRows, maxBytes)
}

// ReadCollectionFields projects known-live fields inside SQLite. A nil field
// list preserves every public field, and limits still cover full stored records.
func ReadCollectionFields(ctx context.Context, db SnapshotReader, collection string, fields []string, maxRows int, maxBytes int64) (result []map[string]any, err error) {
	contentSQL := "value"
	args := []any{}
	if fields != nil {
		placeholders := make([]string, len(fields))
		for index, field := range fields {
			placeholders[index] = "?"
			args = append(args, field)
		}
		contentSQL = `CASE WHEN json_type(value)='object' THEN (
			SELECT json_group_object(key,json(CASE type
				WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null'
				WHEN 'array' THEN value WHEN 'object' THEN value
				ELSE json_quote(value) END))
			FROM json_each(__idb_records.value) WHERE key IN (` + strings.Join(placeholders, ",") + `)
		) END`
	}
	args = append(args, DatabaseName, collection)
	rows, err := db.QueryContext(ctx, `SELECT record_key, `+contentSQL+`, length(CAST(value AS BLOB))
		FROM __idb_records WHERE database_name=? AND store_name=?`, args...)
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
		var storedBytes int64
		if err := rows.Scan(&keyJSON, &content, &storedBytes); err != nil {
			return nil, err
		}
		bytes += int64(len(keyJSON)) + storedBytes
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
		return compareRecordStrings(left, right.(string))
	default:
		return slices.CompareFunc(left.([]any), right.([]any), CompareRecordKeys)
	}

}

func compareRecordStrings(left, right string) int {
	for len(left) > 0 && len(right) > 0 {
		l, leftSize := utf8.DecodeRuneInString(left)
		r, rightSize := utf8.DecodeRuneInString(right)
		if l != r {
			// IndexedDB compares UTF-16 units, so supplementary characters sort
			// by their high surrogate before BMP characters above U+DFFF.
			leftUnit, rightUnit := l, r
			if l >= 0x10000 {
				leftUnit = 0xd800 + ((l - 0x10000) >> 10)
			}
			if r >= 0x10000 {
				rightUnit = 0xd800 + ((r - 0x10000) >> 10)
			}
			if order := cmp.Compare(leftUnit, rightUnit); order != 0 {
				return order
			}
			return cmp.Compare(l, r)
		}
		left, right = left[leftSize:], right[rightSize:]
	}
	return cmp.Compare(len(left), len(right))
}
