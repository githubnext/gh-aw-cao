// Package postgresx stores the current dashboard sources in PostgreSQL.
package postgresx

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

var ErrSourceUnavailable = errors.New("postgres source is unavailable")

type State struct {
	Ready        bool
	Revision     int64
	DataRevision string
	EvaluatedAt  time.Time
	Counts       map[string]int
}

type Store struct {
	db        *sql.DB
	namespace string
}

// SourceReader reads state and sources from one consistent database snapshot.
type SourceReader interface {
	State(context.Context) (State, error)
	LoadSource(context.Context, string, *query.Definition) (model.Source, model.Metrics, error)
	Diagnostics(context.Context) (model.Diagnostics, error)
}

type readTransaction struct {
	store *Store
	tx    *sql.Tx
}

type querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func New(ctx context.Context, dsn string, namespaces ...string) (*Store, error) {
	if len(namespaces) > 1 {
		return nil, errors.New("postgres store accepts at most one namespace")
	}
	namespace := "default"
	if len(namespaces) == 1 {
		namespace = namespaces[0]
	}
	return NewWithNamespace(ctx, dsn, namespace)
}

func NewWithNamespace(ctx context.Context, dsn, namespace string) (*Store, error) {
	if namespace == "" {
		return nil, errors.New("postgres namespace is required")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid postgres connection configuration")
	}
	return NewConfig(ctx, config, namespace)
}

func NewConfig(ctx context.Context, config *pgx.ConnConfig, namespaces ...string) (*Store, error) {
	if config == nil {
		return nil, errors.New("postgres connection configuration is required")
	}
	if len(namespaces) > 1 {
		return nil, errors.New("postgres store accepts at most one namespace")
	}
	namespace := "default"
	if len(namespaces) == 1 {
		namespace = namespaces[0]
	}
	if namespace == "" {
		return nil, errors.New("postgres namespace is required")
	}
	if err := validateTransport(config); err != nil {
		return nil, err
	}
	db := stdlib.OpenDB(*config.Copy())
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := initialize(ctx, db); err != nil {
		_ = db.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("postgres connection or schema initialization failed")
	}
	return &Store{db: db, namespace: namespace}, nil
}

// initialize migrates legacy JSONB columns for every namespace, not just the
// caller's. PostgreSQL commits the schema changes and converted values together:
// a failed conversion leaves the old schema and all tenant data intact. Opening
// the database again after success is a no-op for already converted values.
func initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Serialize initializers sharing a schema, including initializers for other tenants.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(712083241, 17483)`); err != nil {
		return err
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS cao_sources (
			namespace TEXT NOT NULL, source_name TEXT NOT NULL,
			PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE IF NOT EXISTS cao_source_rows (
			namespace TEXT NOT NULL, source_name TEXT NOT NULL, ordinal BIGINT NOT NULL,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS cao_source_documents (
			namespace TEXT NOT NULL, source_name TEXT NOT NULL, ordinal BIGINT NOT NULL,
			payload TEXT NOT NULL, id TEXT, run_id TEXT, session_id TEXT,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS cao_source_documents_id
			ON cao_source_documents (namespace, source_name, id) WHERE id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_source_documents_run_id
			ON cao_source_documents (namespace, source_name, run_id) WHERE run_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_source_documents_session_id
			ON cao_source_documents (namespace, source_name, session_id) WHERE session_id IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS cao_state (
			namespace TEXT PRIMARY KEY, revision BIGINT NOT NULL, data_revision TEXT NOT NULL,
			evaluated_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS cao_values (
			namespace TEXT NOT NULL, source_name TEXT NOT NULL, ordinal BIGINT NOT NULL,
			node_id BIGINT NOT NULL, parent_id BIGINT, object_key TEXT, array_index BIGINT,
			kind TEXT NOT NULL CHECK (kind IN ('object', 'array', 'string', 'number', 'boolean', 'null')),
			text_value TEXT, numeric_value NUMERIC, bool_value BOOLEAN,
			PRIMARY KEY (namespace, source_name, ordinal, node_id),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS cao_counts (
			namespace TEXT NOT NULL REFERENCES cao_state(namespace) ON DELETE CASCADE,
			source_name TEXT NOT NULL, count BIGINT NOT NULL,
			PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE IF NOT EXISTS cao_diagnostic_counts (
			namespace TEXT NOT NULL REFERENCES cao_state(namespace) ON DELETE CASCADE,
			name TEXT NOT NULL, count BIGINT NOT NULL, PRIMARY KEY (namespace, name))`,
		`CREATE TABLE IF NOT EXISTS cao_relationship_errors (
			namespace TEXT NOT NULL REFERENCES cao_state(namespace) ON DELETE CASCADE,
			ordinal BIGINT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (namespace, ordinal))`,
		`CREATE TABLE IF NOT EXISTS cao_duplicate_ids (
			namespace TEXT NOT NULL REFERENCES cao_state(namespace) ON DELETE CASCADE,
			name TEXT NOT NULL, ordinal BIGINT NOT NULL, record_id TEXT NOT NULL,
			PRIMARY KEY (namespace, name, ordinal))`,
		`ALTER TABLE cao_state ADD COLUMN IF NOT EXISTS schema_version BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE cao_state ADD COLUMN IF NOT EXISTS diagnostic_counts_present BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE cao_state ADD COLUMN IF NOT EXISTS relationship_errors_present BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE cao_state ADD COLUMN IF NOT EXISTS duplicate_ids_present BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS estimated_bytes BIGINT`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	for _, legacy := range []struct {
		table, column string
		migrate       func(context.Context, *sql.Tx) error
	}{
		{"cao_sources", "metadata", migrateMetadata},
		{"cao_source_rows", "payload", migrateRows},
		{"cao_state", "counts", migrateState},
	} {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1)
			AND attname = $2 AND NOT attisdropped)`, legacy.table, legacy.column).Scan(&exists); err != nil {
			return err
		}
		if exists {
			if err = legacy.migrate(ctx, tx); err != nil {
				return err
			}
		}
	}
	for _, statement := range []string{
		`ALTER TABLE cao_sources DROP COLUMN IF EXISTS metadata`,
		`ALTER TABLE cao_source_rows DROP COLUMN IF EXISTS payload`,
		`ALTER TABLE cao_state DROP COLUMN IF EXISTS counts`,
		`ALTER TABLE cao_state DROP COLUMN IF EXISTS diagnostics`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func migrateMetadata(ctx context.Context, tx *sql.Tx) error {
	return migrateTrees(ctx, tx, `SELECT namespace, source_name, metadata FROM cao_sources`, false)
}

func migrateRows(ctx context.Context, tx *sql.Tx) error {
	return migrateTrees(ctx, tx, `SELECT namespace, source_name, ordinal, payload FROM cao_source_rows`, true)
}

func migrateTrees(ctx context.Context, tx *sql.Tx, selectSQL string, hasOrdinal bool) error {
	// FETCH closes before inserts on the same transaction connection. A bounded
	// cursor avoids retaining all legacy JSONB rows in memory during migration.
	cursor := "cao_metadata_cursor"
	if hasOrdinal {
		cursor = "cao_rows_cursor"
	}
	if _, err := tx.ExecContext(ctx, `DECLARE `+cursor+` NO SCROLL CURSOR FOR `+selectSQL); err != nil {
		return err
	}
	batch := valueBatch{ctx: ctx, tx: tx}
	type item struct {
		namespace, name string
		ordinal         int64
		payload         []byte
	}
	for {
		rows, err := tx.QueryContext(ctx, `FETCH FORWARD 256 FROM `+cursor)
		if err != nil {
			return err
		}
		items, err := func() ([]item, error) {
			defer func() { _ = rows.Close() }()
			items := make([]item, 0, 256)
			for rows.Next() {
				v := item{ordinal: -1}
				var scanErr error
				if hasOrdinal {
					scanErr = rows.Scan(&v.namespace, &v.name, &v.ordinal, &v.payload)
				} else {
					scanErr = rows.Scan(&v.namespace, &v.name, &v.payload)
				}
				if scanErr != nil {
					return nil, scanErr
				}
				items = append(items, v)
			}
			return items, rows.Err()
		}()
		if err != nil {
			return err
		}
		if len(items) == 0 {
			break
		}
		for _, v := range items {
			var value any
			if err = decodeJSON(v.payload, &value); err != nil {
				return err
			}
			if err = batch.addTree(v.namespace, v.name, v.ordinal, value); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `CLOSE `+cursor); err != nil {
		return err
	}
	return batch.flush()
}

func migrateState(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT namespace, counts, diagnostics FROM cao_state`)
	if err != nil {
		return err
	}
	type item struct {
		namespace           string
		counts, diagnostics []byte
	}
	items, err := func() ([]item, error) {
		defer func() { _ = rows.Close() }()
		var items []item
		for rows.Next() {
			var v item
			if scanErr := rows.Scan(&v.namespace, &v.counts, &v.diagnostics); scanErr != nil {
				return nil, scanErr
			}
			items = append(items, v)
		}
		return items, rows.Err()
	}()
	if err != nil {
		return err
	}
	for _, v := range items {
		var counts map[string]int
		var diag model.Diagnostics
		if err = decodeJSON(v.counts, &counts); err != nil {
			return err
		}
		if err = decodeJSON(v.diagnostics, &diag); err != nil {
			return err
		}
		if err = writeCounts(ctx, tx, v.namespace, counts); err != nil {
			return err
		}
		if err = writeDiagnostics(ctx, tx, v.namespace, diag); err != nil {
			return err
		}
	}
	return nil
}

func validateTransport(config *pgx.ConnConfig) error {
	secure := func(host string, tlsEnabled bool) bool {
		if tlsEnabled || filepath.IsAbs(host) || strings.EqualFold(host, "localhost") {
			return true
		}
		addr, err := netip.ParseAddr(host)
		return err == nil && addr.IsLoopback()
	}
	if !secure(config.Host, config.TLSConfig != nil) {
		return errors.New("postgres TLS is required for non-loopback connections")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !secure(fallback.Host, fallback.TLSConfig != nil) {
			return errors.New("postgres TLS is required for non-loopback fallback connections")
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }
func (s *Store) State(ctx context.Context) (State, error) {
	var state State
	err := s.WithReadTransaction(ctx, func(reader SourceReader) (err error) {
		state, err = reader.State(ctx)
		return err
	})
	return state, err
}
func (r *readTransaction) State(ctx context.Context) (State, error) {
	return r.store.readState(ctx, r.tx)
}

func (s *Store) readState(ctx context.Context, db querier) (State, error) {
	state := State{Counts: map[string]int{}}
	err := db.QueryRowContext(ctx, `SELECT revision, data_revision, evaluated_at FROM cao_state WHERE namespace = $1`, s.namespace).
		Scan(&state.Revision, &state.DataRevision, &state.EvaluatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read postgres state: %w", err)
	}
	rows, err := db.QueryContext(ctx, `SELECT source_name, count FROM cao_counts WHERE namespace = $1`, s.namespace)
	if err != nil {
		return State{}, fmt.Errorf("read postgres counts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		var count int
		if err = rows.Scan(&name, &count); err != nil {
			break
		}
		state.Counts[name] = count
	}
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		return State{}, fmt.Errorf("read postgres counts: %w", err)
	}
	state.Ready = true
	return state, nil
}

// Replace atomically swaps all sources and state. The state row serializes writers per namespace.
func (s *Store) Replace(ctx context.Context, sources map[string]model.Source, diagnostics model.Diagnostics, dataRevision string, evaluatedAt time.Time) (revision int64, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin postgres replacement: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_state (namespace, revision, data_revision, evaluated_at)
		VALUES ($1, 0, '', 'epoch'::timestamptz) ON CONFLICT (namespace) DO NOTHING`, s.namespace); err != nil {
		return 0, fmt.Errorf("initialize postgres state: %w", err)
	}
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM cao_state WHERE namespace = $1 FOR UPDATE`, s.namespace).Scan(&revision); err != nil {
		return 0, fmt.Errorf("lock postgres state: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM cao_sources WHERE namespace = $1`, s.namespace); err != nil {
		return 0, fmt.Errorf("clear postgres sources: %w", err)
	}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	counts := make(map[string]int, len(sources))
	values := valueBatch{ctx: ctx, tx: tx}
	for _, name := range names {
		source := sources[name]
		if name == "" || (source.Source != "" && source.Source != name) {
			return 0, fmt.Errorf("invalid postgres source name %q", name)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO cao_sources (namespace, source_name) VALUES ($1, $2)`,
			s.namespace, name); err != nil {
			return 0, fmt.Errorf("insert postgres source %q: %w", name, err)
		}
		var value any
		if value, err = normalize(source.Metadata); err != nil {
			return 0, fmt.Errorf("normalize metadata for %q: %w", name, err)
		}
		if err = values.addTree(s.namespace, name, -1, value); err != nil {
			return 0, fmt.Errorf("insert metadata for %q: %w", name, err)
		}
		sourceRows := rowBatch{ctx: ctx, tx: tx, namespace: s.namespace, name: name}
		documents := documentBatch{ctx: ctx, tx: tx, namespace: s.namespace, name: name}
		var estimatedBytes int64
		if err = documents.add(-1, value); err != nil {
			return 0, fmt.Errorf("insert document metadata for %q: %w", name, err)
		}
		for ordinal, row := range source.Rows {
			if row == nil {
				return 0, fmt.Errorf("nil row in postgres source %q", name)
			}
			if value, err = normalize(row); err != nil {
				return 0, fmt.Errorf("normalize row in %q: %w", name, err)
			}
			estimatedBytes += query.EstimateRowsBytes([]model.Row{value.(map[string]any)})
			if err = sourceRows.add(int64(ordinal)); err != nil {
				return 0, fmt.Errorf("insert postgres row in %q: %w", name, err)
			}
			if err = values.addTree(s.namespace, name, int64(ordinal), value); err != nil {
				return 0, fmt.Errorf("insert row in %q: %w", name, err)
			}
			if err = documents.add(int64(ordinal), value); err != nil {
				return 0, fmt.Errorf("insert document row in %q: %w", name, err)
			}
		}
		if err = sourceRows.flush(); err != nil {
			return 0, fmt.Errorf("insert postgres rows in %q: %w", name, err)
		}
		if err = documents.flush(); err != nil {
			return 0, fmt.Errorf("insert postgres documents in %q: %w", name, err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE cao_sources SET estimated_bytes = $1
			WHERE namespace = $2 AND source_name = $3`, estimatedBytes, s.namespace, name); err != nil {
			return 0, fmt.Errorf("update postgres source size in %q: %w", name, err)
		}
		counts[name] = len(source.Rows)
	}
	if err = values.flush(); err != nil {
		return 0, fmt.Errorf("insert postgres values: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM cao_counts WHERE namespace = $1`, s.namespace); err != nil {
		return 0, err
	}
	if err = writeCounts(ctx, tx, s.namespace, counts); err != nil {
		return 0, err
	}
	if err = clearDiagnostics(ctx, tx, s.namespace); err != nil {
		return 0, err
	}
	if err = writeDiagnostics(ctx, tx, s.namespace, diagnostics); err != nil {
		return 0, err
	}
	if err = tx.QueryRowContext(ctx, `UPDATE cao_state SET revision = revision + 1,
		data_revision = $1, evaluated_at = $2 WHERE namespace = $3 RETURNING revision`,
		dataRevision, evaluatedAt, s.namespace).Scan(&revision); err != nil {
		return 0, fmt.Errorf("update postgres state: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit postgres replacement: %w", err)
	}
	return revision, nil
}

func writeCounts(ctx context.Context, tx *sql.Tx, namespace string, counts map[string]int) error {
	for name, count := range counts {
		if _, err := tx.ExecContext(ctx, `INSERT INTO cao_counts (namespace, source_name, count) VALUES ($1, $2, $3)`, namespace, name, count); err != nil {
			return err
		}
	}
	return nil
}

func clearDiagnostics(ctx context.Context, tx *sql.Tx, namespace string) error {
	for _, statement := range []string{
		`DELETE FROM cao_diagnostic_counts WHERE namespace = $1`,
		`DELETE FROM cao_relationship_errors WHERE namespace = $1`,
		`DELETE FROM cao_duplicate_ids WHERE namespace = $1`,
	} {
		if _, err := tx.ExecContext(ctx, statement, namespace); err != nil {
			return err
		}
	}
	return nil
}

func writeDiagnostics(ctx context.Context, tx *sql.Tx, namespace string, d model.Diagnostics) error {
	if _, err := tx.ExecContext(ctx, `UPDATE cao_state SET schema_version = $1, diagnostic_counts_present = $2,
		relationship_errors_present = $3, duplicate_ids_present = $4 WHERE namespace = $5`,
		d.SchemaVersion, d.Counts != nil, d.RelationshipErrors != nil, d.DuplicateRecordIDs != nil, namespace); err != nil {
		return err
	}
	for name, count := range d.Counts {
		if _, err := tx.ExecContext(ctx, `INSERT INTO cao_diagnostic_counts (namespace, name, count) VALUES ($1, $2, $3)`, namespace, name, count); err != nil {
			return err
		}
	}
	for i, message := range d.RelationshipErrors {
		if _, err := tx.ExecContext(ctx, `INSERT INTO cao_relationship_errors (namespace, ordinal, message) VALUES ($1, $2, $3)`, namespace, i, message); err != nil {
			return err
		}
	}
	for name, ids := range d.DuplicateRecordIDs {
		// Sentinels distinguish null and empty lists from a missing map key.
		if ids == nil {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cao_duplicate_ids (namespace, name, ordinal, record_id) VALUES ($1, $2, -2, '')`, namespace, name); err != nil {
				return err
			}
		} else if len(ids) == 0 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cao_duplicate_ids (namespace, name, ordinal, record_id) VALUES ($1, $2, -1, '')`, namespace, name); err != nil {
				return err
			}
		}
		for i, id := range ids {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cao_duplicate_ids (namespace, name, ordinal, record_id) VALUES ($1, $2, $3, $4)`, namespace, name, i, id); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalize(value any) (any, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	err = decodeJSON(payload, &normalized)
	return normalized, err
}

const valueBatchSize = 256
const rowBatchSize = 512

type valueEntry struct {
	namespace, name string
	ordinal, id     int64
	parent, key     any
	index           any
	kind            string
	text, numeric   any
	boolean         any
}

type valueBatch struct {
	ctx     context.Context
	tx      *sql.Tx
	entries []valueEntry
}

func (b *valueBatch) addTree(namespace, name string, ordinal int64, value any) error {
	var next int64
	var walk func(any, any, any, any) error
	walk = func(v any, parent, key, index any) error {
		id := next
		next++
		entry := valueEntry{namespace: namespace, name: name, ordinal: ordinal, id: id,
			parent: parent, key: key, index: index, kind: "null"}
		switch x := v.(type) {
		case map[string]any:
			entry.kind = "object"
		case []any:
			entry.kind = "array"
		case string:
			entry.kind, entry.text = "string", x
		case json.Number:
			entry.kind, entry.text = "number", string(x)
			// Keep the original lexeme even for numbers outside PostgreSQL NUMERIC's range.
			if len(x) <= 1000 {
				exponent := 0
				validExponent := true
				if pos := strings.IndexAny(string(x), "eE"); pos >= 0 {
					var parseErr error
					exponent, parseErr = strconv.Atoi(string(x)[pos+1:])
					validExponent = parseErr == nil
				}
				if validExponent && exponent >= -1000 && exponent <= 1000 {
					entry.numeric = string(x)
				}
			}
		case bool:
			entry.kind, entry.boolean = "boolean", x
		case nil:
		default:
			return fmt.Errorf("unsupported normalized value %T", v)
		}
		b.entries = append(b.entries, entry)
		if len(b.entries) >= valueBatchSize {
			if err := b.flush(); err != nil {
				return err
			}
		}
		switch x := v.(type) {
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if err := walk(x[k], id, k, nil); err != nil {
					return err
				}
			}
		case []any:
			for i, child := range x {
				if err := walk(child, id, nil, i); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(value, nil, nil, nil)
}

func (b *valueBatch) flush() error {
	if len(b.entries) == 0 {
		return nil
	}
	var statement strings.Builder
	statement.WriteString(`INSERT INTO cao_values
		(namespace, source_name, ordinal, node_id, parent_id, object_key, array_index, kind, text_value, numeric_value, bool_value) VALUES `)
	args := make([]any, 0, len(b.entries)*11)
	for i, entry := range b.entries {
		if i > 0 {
			statement.WriteByte(',')
		}
		statement.WriteByte('(')
		for column := 0; column < 11; column++ {
			if column > 0 {
				statement.WriteByte(',')
			}
			statement.WriteByte('$')
			statement.WriteString(strconv.Itoa(i*11 + column + 1))
			if column == 9 {
				statement.WriteString("::numeric")
			}
		}
		statement.WriteByte(')')
		args = append(args, entry.namespace, entry.name, entry.ordinal, entry.id, entry.parent,
			entry.key, entry.index, entry.kind, entry.text, entry.numeric, entry.boolean)
	}
	if _, err := b.tx.ExecContext(b.ctx, statement.String(), args...); err != nil {
		return err
	}
	b.entries = b.entries[:0]
	return nil
}

type rowBatch struct {
	ctx             context.Context
	tx              *sql.Tx
	namespace, name string
	ordinals        []int64
}

func (b *rowBatch) add(ordinal int64) error {
	b.ordinals = append(b.ordinals, ordinal)
	if len(b.ordinals) >= rowBatchSize {
		return b.flush()
	}
	return nil
}

func (b *rowBatch) flush() error {
	if len(b.ordinals) == 0 {
		return nil
	}
	var statement strings.Builder
	statement.WriteString(`INSERT INTO cao_source_rows (namespace, source_name, ordinal) VALUES `)
	args := make([]any, 0, 2+len(b.ordinals))
	args = append(args, b.namespace, b.name)
	for i, ordinal := range b.ordinals {
		if i > 0 {
			statement.WriteByte(',')
		}
		statement.WriteString("($1,$2,$")
		statement.WriteString(strconv.Itoa(i + 3))
		statement.WriteByte(')')
		args = append(args, ordinal)
	}
	if _, err := b.tx.ExecContext(b.ctx, statement.String(), args...); err != nil {
		return err
	}
	b.ordinals = b.ordinals[:0]
	return nil
}

type documentEntry struct {
	ordinal              int64
	payload              string
	id, runID, sessionID any
}

type documentBatch struct {
	ctx             context.Context
	tx              *sql.Tx
	namespace, name string
	entries         []documentEntry
}

func (b *documentBatch) add(ordinal int64, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	entry := documentEntry{ordinal: ordinal, payload: string(payload)}
	if row, ok := value.(map[string]any); ok {
		entry.id = documentKey(row["id"])
		entry.runID = documentKey(row["runId"])
		entry.sessionID = documentKey(row["sessionId"])
	}
	b.entries = append(b.entries, entry)
	if len(b.entries) >= rowBatchSize {
		return b.flush()
	}
	return nil
}

func documentKey(value any) any {
	if value == nil {
		return nil
	}
	return fmt.Sprint(value)
}

func (b *documentBatch) flush() error {
	if len(b.entries) == 0 {
		return nil
	}
	var statement strings.Builder
	statement.WriteString(`INSERT INTO cao_source_documents
		(namespace, source_name, ordinal, payload, id, run_id, session_id) VALUES `)
	args := []any{b.namespace, b.name}
	for i, entry := range b.entries {
		if i > 0 {
			statement.WriteByte(',')
		}
		statement.WriteString("($1,$2")
		for column := 0; column < 5; column++ {
			statement.WriteString(",$")
			statement.WriteString(strconv.Itoa(3 + i*5 + column))
		}
		statement.WriteByte(')')
		args = append(args, entry.ordinal, entry.payload, entry.id, entry.runID, entry.sessionID)
	}
	if _, err := b.tx.ExecContext(b.ctx, statement.String(), args...); err != nil {
		return err
	}
	b.entries = b.entries[:0]
	return nil
}

// WithReadTransaction holds a single repeatable-read snapshot for the callback.
func (s *Store) WithReadTransaction(ctx context.Context, fn func(SourceReader) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return fmt.Errorf("begin postgres source read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(&readTransaction{store: s, tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit postgres source read: %w", err)
	}
	return nil
}

// LoadSource reads source rows with namespace, source name and ordinal predicates
// in SQL. It deliberately leaves Dashboard Language filter/compute/join/limit
// semantics and resource accounting to the Go query engine.
func (s *Store) LoadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	var source model.Source
	var metrics model.Metrics
	err := s.WithReadTransaction(ctx, func(reader SourceReader) (err error) {
		source, metrics, err = reader.LoadSource(ctx, name, definition)
		return err
	})
	return source, metrics, err
}

func (r *readTransaction) LoadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	_ = definition
	s, tx := r.store, r.tx
	rows, err := tx.QueryContext(ctx, `SELECT positions.ordinal, v.node_id, v.parent_id, v.object_key,
			v.array_index, v.kind, v.text_value, v.bool_value
		FROM (
			SELECT -1::bigint AS ordinal FROM cao_sources WHERE namespace = $1 AND source_name = $2
			UNION ALL
			SELECT ordinal FROM cao_source_rows WHERE namespace = $1 AND source_name = $2
		) AS positions
		LEFT JOIN cao_values AS v ON v.namespace = $1 AND v.source_name = $2 AND v.ordinal = positions.ordinal
		ORDER BY positions.ordinal, v.node_id`, s.namespace, name)
	if err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres source: %w", err)
	}
	defer func() { _ = rows.Close() }()
	source := model.Source{Source: name, Rows: []model.Row{}}
	var nodes []*valueNode
	var ordinal int64
	found := false
	finish := func() error {
		value, err := decodeTree(nodes)
		if err != nil {
			return err
		}
		if ordinal == -1 {
			if value != nil {
				var ok bool
				source.Metadata, ok = value.(map[string]any)
				if !ok {
					return errors.New("invalid postgres metadata root")
				}
			}
		} else {
			row, ok := value.(map[string]any)
			if !ok {
				return errors.New("invalid postgres row root")
			}
			source.Rows = append(source.Rows, row)
		}
		return nil
	}
	for rows.Next() {
		n := new(valueNode)
		var nextOrdinal int64
		var nodeID sql.NullInt64
		var kind sql.NullString
		if err = rows.Scan(&nextOrdinal, &nodeID, &n.parent, &n.key, &n.index, &kind, &n.text, &n.boolean); err != nil {
			return model.Source{}, model.Metrics{}, fmt.Errorf("scan postgres source: %w", err)
		}
		if !found && nextOrdinal != -1 {
			return model.Source{}, model.Metrics{}, errors.New("missing postgres metadata")
		}
		if found && nextOrdinal != ordinal {
			if err = finish(); err != nil {
				return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres source: %w", err)
			}
			nodes = nil
		}
		found, ordinal = true, nextOrdinal
		if !nodeID.Valid {
			return model.Source{}, model.Metrics{}, errors.New("missing postgres value root")
		}
		n.id, n.kind = nodeID.Int64, kind.String
		if err = n.decode(); err != nil {
			return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres source: %w", err)
		}
		nodes = append(nodes, n)
	}
	if err = rows.Err(); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres source: %w", err)
	}
	if !found {
		return model.Source{}, model.Metrics{}, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	if err = finish(); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres source: %w", err)
	}
	return source, model.Metrics{OutputRows: len(source.Rows)}, nil
}

type valueNode struct {
	id            int64
	parent, index sql.NullInt64
	key, text     sql.NullString
	kind          string
	boolean       sql.NullBool
	value         any
}

func (n *valueNode) decode() error {
	switch n.kind {
	case "object":
		n.value = map[string]any{}
	case "array":
		n.value = []any{}
	case "string":
		n.value = n.text.String
	case "number":
		n.value = json.Number(n.text.String)
	case "boolean":
		n.value = n.boolean.Bool
	case "null":
		n.value = nil
	default:
		return fmt.Errorf("unknown postgres value kind %q", n.kind)
	}
	return nil
}

func decodeTree(nodes []*valueNode) (any, error) {
	if len(nodes) == 0 || nodes[0].id != 0 || nodes[0].parent.Valid {
		return nil, errors.New("missing postgres value root")
	}
	byID := make(map[int64]*valueNode, len(nodes))
	for _, n := range nodes {
		if _, exists := byID[n.id]; exists {
			return nil, errors.New("duplicate postgres value node")
		}
		byID[n.id] = n
	}
	arraySizes := map[int64]int{}
	for _, n := range nodes {
		if n.parent.Valid {
			arraySizes[n.parent.Int64]++
		}
	}
	for _, n := range nodes {
		if n.kind == "array" {
			n.value = make([]any, arraySizes[n.id])
		}
	}
	for i := len(nodes) - 1; i >= 0; i-- {
		n := nodes[i]
		if !n.parent.Valid {
			continue
		}
		parent := byID[n.parent.Int64]
		if parent == nil || parent.id >= n.id {
			return nil, errors.New("missing postgres value parent")
		}
		switch parent.kind {
		case "object":
			if !n.key.Valid {
				return nil, errors.New("missing postgres object key")
			}
			parent.value.(map[string]any)[n.key.String] = n.value
		case "array":
			if !n.index.Valid || n.index.Int64 < 0 || n.index.Int64 >= int64(len(parent.value.([]any))) {
				return nil, errors.New("invalid postgres array index")
			}
			parent.value.([]any)[n.index.Int64] = n.value
		default:
			return nil, errors.New("invalid postgres value parent")
		}
	}
	return nodes[0].value, nil
}

func (s *Store) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	var diagnostics model.Diagnostics
	err := s.WithReadTransaction(ctx, func(reader SourceReader) (err error) {
		diagnostics, err = reader.Diagnostics(ctx)
		return err
	})
	return diagnostics, err
}
func (r *readTransaction) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	return r.store.readDiagnostics(ctx, r.tx)
}

func (s *Store) readDiagnostics(ctx context.Context, db querier) (model.Diagnostics, error) {
	var d model.Diagnostics
	var counts, relationships, duplicates bool
	err := db.QueryRowContext(ctx, `SELECT schema_version, diagnostic_counts_present,
		relationship_errors_present, duplicate_ids_present FROM cao_state WHERE namespace = $1 AND revision > 0`, s.namespace).
		Scan(&d.SchemaVersion, &counts, &relationships, &duplicates)
	if errors.Is(err, sql.ErrNoRows) {
		return d, nil
	}
	if err != nil {
		return d, fmt.Errorf("read postgres diagnostics: %w", err)
	}
	if counts {
		d.Counts = map[string]int{}
	}
	if relationships {
		d.RelationshipErrors = []string{}
	}
	if duplicates {
		d.DuplicateRecordIDs = map[string][]string{}
	}
	if err := scanDiagnosticRows(ctx, db, `SELECT name, count FROM cao_diagnostic_counts WHERE namespace = $1`, s.namespace, func(rows *sql.Rows) error {
		for rows.Next() {
			var name string
			var count int
			if err := rows.Scan(&name, &count); err != nil {
				return err
			}
			d.Counts[name] = count
		}
		return rows.Err()
	}); err != nil {
		return d, err
	}
	if err := scanDiagnosticRows(ctx, db, `SELECT message FROM cao_relationship_errors WHERE namespace = $1 ORDER BY ordinal`, s.namespace, func(rows *sql.Rows) error {
		for rows.Next() {
			var message string
			if err := rows.Scan(&message); err != nil {
				return err
			}
			d.RelationshipErrors = append(d.RelationshipErrors, message)
		}
		return rows.Err()
	}); err != nil {
		return d, err
	}
	err = scanDiagnosticRows(ctx, db, `SELECT name, ordinal, record_id FROM cao_duplicate_ids WHERE namespace = $1 ORDER BY name, ordinal`, s.namespace, func(rows *sql.Rows) error {
		for rows.Next() {
			var name, id string
			var ordinal int64
			if err := rows.Scan(&name, &ordinal, &id); err != nil {
				return err
			}
			switch ordinal {
			case -2:
				d.DuplicateRecordIDs[name] = nil
			case -1:
				d.DuplicateRecordIDs[name] = []string{}
			default:
				d.DuplicateRecordIDs[name] = append(d.DuplicateRecordIDs[name], id)
			}
		}
		return rows.Err()
	})
	return d, err
}

func scanDiagnosticRows(ctx context.Context, db querier, statement, namespace string, scan func(*sql.Rows) error) error {
	rows, err := db.QueryContext(ctx, statement, namespace)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	if err := scan(rows); err != nil {
		return err
	}
	return rows.Err()
}

func decodeJSON(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(dest)
}
