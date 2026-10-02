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
var ErrFreshDatabaseRequired = errors.New("native PostgreSQL storage requires an empty database")

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
	LoadDocument(context.Context, string, string) (model.Row, error)
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
	config, err := instrumentConfig(config)
	if err != nil {
		return nil, fmt.Errorf("configure postgres telemetry: %w", err)
	}
	db := stdlib.OpenDB(*config)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := initialize(ctx, db); err != nil {
		_ = db.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, ErrFreshDatabaseRequired) {
			return nil, ErrFreshDatabaseRequired
		}
		return nil, errors.New("postgres connection or schema initialization failed")
	}
	return &Store{db: db, namespace: namespace}, nil
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

// DeleteNamespace removes only this store's data. Benchmark callers use it to
// discard a unique per-run namespace without affecting other consumers.
func (s *Store) DeleteNamespace(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `DELETE FROM cao_sources WHERE namespace = $1`, s.namespace); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM cao_state WHERE namespace = $1`, s.namespace); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) State(ctx context.Context) (State, error) {
	var state State
	err := s.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) (err error) {
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
	countSQL, args, err := postgresSQL(`SELECT source_name, count FROM cao_counts WHERE namespace = {}`, s.namespace)
	if err != nil {
		return State{}, err
	}
	rows, err := db.QueryContext(ctx, countSQL, args...)
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
	deleteSQL, deleteArgs, err := postgresSQL(`DELETE FROM cao_sources WHERE namespace = {}`, s.namespace)
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, deleteSQL, deleteArgs...); err != nil {
		return 0, fmt.Errorf("clear postgres sources: %w", err)
	}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	counts := make(map[string]int, len(sources))
	for _, name := range names {
		source := sources[name]
		if name == "" || (source.Source != "" && source.Source != name) {
			return 0, fmt.Errorf("invalid postgres source name %q", name)
		}
		insertSQL, insertArgs, buildErr := postgresSQL(
			`INSERT INTO cao_sources (namespace, source_name) VALUES ({}, {})`, s.namespace, name,
		)
		if buildErr != nil {
			return 0, buildErr
		}
		if _, err = tx.ExecContext(ctx, insertSQL, insertArgs...); err != nil {
			return 0, fmt.Errorf("insert postgres source %q: %w", name, err)
		}
		var value any
		if value, err = normalize(source.Metadata); err != nil {
			return 0, fmt.Errorf("normalize metadata for %q: %w", name, err)
		}
		documents := documentBatch{ctx: ctx, tx: tx, namespace: s.namespace, name: name}
		// Known producer fields cannot silently fall back to an EAV tree.
		typed := isCanonicalSource(name)
		if typed {
			for _, row := range source.Rows {
				if row == nil {
					return 0, fmt.Errorf("nil row in postgres source %q", name)
				}
				if len(row) == 0 {
					continue
				}
				normalized, normalizeErr := normalize(row)
				if normalizeErr != nil {
					return 0, normalizeErr
				}
				_, _, _, ok, checkErr := canonicalRow(normalized.(map[string]any))
				if checkErr != nil {
					return 0, checkErr
				}
				if !ok {
					return 0, fmt.Errorf("canonical source %q: %s", name,
						canonicalFallbackReason(normalized.(map[string]any)))
				}
			}
		}
		var estimatedBytes int64
		if typed {
			if err = writeCanonicalMetadata(ctx, tx, s.namespace, name, value, len(source.Rows)); err != nil {
				return 0, fmt.Errorf("insert canonical metadata for %q: %w", name, err)
			}
		} else if err = documents.add(-1, value); err != nil {
			return 0, fmt.Errorf("insert document metadata for %q: %w", name, err)
		}
		emptyStart := -1
		flushEmpty := func(end int) error {
			if emptyStart < 0 {
				return nil
			}
			_, flushErr := tx.ExecContext(ctx, `INSERT INTO cao_canonical_rows
				(namespace, source_name, ordinal, present, extension)
				SELECT $1, $2, ordinal, ARRAY[]::text[], NULL::json
				FROM generate_series($3::bigint, $4::bigint) AS ordinal`,
				s.namespace, name, emptyStart, end-1)
			emptyStart = -1
			return flushErr
		}
		for ordinal, row := range source.Rows {
			if row == nil {
				return 0, fmt.Errorf("nil row in postgres source %q", name)
			}
			if typed && len(row) == 0 {
				if emptyStart < 0 {
					emptyStart = ordinal
				}
				estimatedBytes += query.EstimateRowsBytes([]model.Row{{}})
				continue
			}
			if err = flushEmpty(ordinal); err != nil {
				return 0, fmt.Errorf("insert empty canonical rows in %q: %w", name, err)
			}
			if value, err = normalize(row); err != nil {
				return 0, fmt.Errorf("normalize row in %q: %w", name, err)
			}
			estimatedBytes += query.EstimateRowsBytes([]model.Row{value.(map[string]any)})
			if typed {
				if _, err = insertCanonical(ctx, tx, s.namespace, name, int64(ordinal), value.(map[string]any)); err != nil {
					return 0, fmt.Errorf("insert canonical row in %q: %w", name, err)
				}
			} else {
				if err = documents.add(int64(ordinal), value); err != nil {
					return 0, fmt.Errorf("insert document row in %q: %w", name, err)
				}
			}
		}
		if err = flushEmpty(len(source.Rows)); err != nil {
			return 0, fmt.Errorf("insert empty canonical rows in %q: %w", name, err)
		}
		if err = documents.flush(); err != nil {
			return 0, fmt.Errorf("insert postgres documents in %q: %w", name, err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE cao_sources SET estimated_bytes = $1,
			is_canonical = $2
			WHERE namespace = $3 AND source_name = $4`, estimatedBytes, typed, s.namespace, name); err != nil {
			return 0, fmt.Errorf("update postgres source size in %q: %w", name, err)
		}
		counts[name] = len(source.Rows)
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

const documentBatchSize = 512

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
	if len(b.entries) >= documentBatchSize {
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

func canonicalMetadataFields(value any, count int) (any, []string, [4]any, bool, error) {
	var fields [4]any
	if value == nil {
		return nil, []string{}, fields, false, nil
	}
	metadata, ok := value.(map[string]any)
	if !ok {
		return nil, nil, fields, false, errors.New("invalid canonical metadata root")
	}
	extension := make(map[string]any, len(metadata))
	for key, value := range metadata {
		extension[key] = value
	}
	present := make([]string, 0, 5)
	for index, key := range []string{"source-id", "source-revision", "availability", "source-kind"} {
		if value, found := extension[key]; found {
			if value != nil {
				text, ok := value.(string)
				if !ok {
					return nil, nil, fields, false, fmt.Errorf("invalid canonical metadata field %q", key)
				}
				fields[index] = text
			}
			present = append(present, key)
			delete(extension, key)
		}
	}
	var rowCountNull bool
	if value, found := extension["row-count"]; found {
		if value != nil {
			number, ok := value.(json.Number)
			if !ok || string(number) != strconv.Itoa(count) {
				return nil, nil, fields, false, errors.New("canonical metadata row-count differs from source count")
			}
		} else {
			rowCountNull = true
		}
		present = append(present, "row-count")
		delete(extension, "row-count")
	}
	sort.Strings(present)
	encoded, err := json.Marshal(extension)
	if err != nil {
		return nil, nil, fields, false, err
	}
	return string(encoded), present, fields, rowCountNull, nil
}

func writeCanonicalMetadata(ctx context.Context, tx *sql.Tx, namespace, name string, value any, count int) error {
	extension, present, fields, rowCountNull, err := canonicalMetadataFields(value, count)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE cao_sources
		SET metadata_extension = $1, metadata_present = $2,
			metadata_source_id = $3, metadata_source_revision = $4,
			metadata_availability = $5, metadata_source_kind = $6,
			metadata_row_count_null = $7
		WHERE namespace = $8 AND source_name = $9`,
		extension, present, fields[0], fields[1], fields[2], fields[3], rowCountNull, namespace, name); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2 AND ordinal = -1`, namespace, name)
	return err
}

func readCanonicalMetadata(ctx context.Context, tx *sql.Tx, namespace, name string) (model.Metadata, error) {
	var extension, sourceID, revision, availability, sourceKind sql.NullString
	var present []string
	var rowCountNull bool
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT s.metadata_extension::text,
		s.metadata_present, s.metadata_source_id, s.metadata_source_revision,
		s.metadata_availability, s.metadata_source_kind, s.metadata_row_count_null, c.count
		FROM cao_sources s JOIN cao_counts c
		ON c.namespace = s.namespace AND c.source_name = s.source_name
		WHERE s.namespace = $1 AND s.source_name = $2 AND s.is_canonical`,
		namespace, name).Scan(&extension, &present, &sourceID, &revision,
		&availability, &sourceKind, &rowCountNull, &count); err != nil {
		return nil, err
	}
	if !extension.Valid {
		if len(present) != 0 || sourceID.Valid || revision.Valid || availability.Valid || sourceKind.Valid || rowCountNull {
			return nil, errors.New("inconsistent null postgres canonical metadata")
		}
		//nolint:nilnil // A nil metadata map is a valid, distinct source value.
		return nil, nil
	}
	var metadata model.Metadata
	if err := decodeJSON([]byte(extension.String), &metadata); err != nil || metadata == nil {
		return nil, errors.New("invalid postgres canonical metadata extension")
	}
	for _, key := range []string{"source-id", "source-revision", "availability", "source-kind", "row-count"} {
		if _, duplicated := metadata[key]; duplicated {
			return nil, fmt.Errorf("canonical metadata field %q retained in extension", key)
		}
	}
	values := []sql.NullString{sourceID, revision, availability, sourceKind}
	observed := make(map[string]bool, len(present))
	for _, key := range present {
		if observed[key] {
			return nil, fmt.Errorf("duplicate canonical metadata presence %q", key)
		}
		observed[key] = true
	}
	for index, key := range []string{"source-id", "source-revision", "availability", "source-kind"} {
		if values[index].Valid && !observed[key] {
			return nil, fmt.Errorf("canonical metadata field %q lacks presence", key)
		}
		if observed[key] {
			if values[index].Valid {
				metadata[key] = values[index].String
			} else {
				metadata[key] = nil
			}
		}
	}
	if rowCountNull && !observed["row-count"] {
		return nil, errors.New("null canonical row-count lacks presence")
	}
	for key := range observed {
		switch key {
		case "source-id", "source-revision", "availability", "source-kind", "row-count":
		default:
			return nil, fmt.Errorf("unsupported canonical metadata presence %q", key)
		}
	}
	if observed["row-count"] {
		if rowCountNull {
			metadata["row-count"] = nil
		} else {
			metadata["row-count"] = json.Number(strconv.Itoa(count))
		}
	}
	return metadata, nil
}

// WithReadTransaction holds a single repeatable-read snapshot for the callback.
func (s *Store) WithReadTransaction(ctx context.Context, fn func(context.Context, SourceReader) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return fmt.Errorf("begin postgres source read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(ctx, &readTransaction{store: s, tx: tx}); err != nil {
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
	err := s.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) (err error) {
		source, metrics, err = reader.LoadSource(ctx, name, definition)
		return err
	})
	return source, metrics, err
}

// LoadDocument reads one source document by its indexed ID.
func (s *Store) LoadDocument(ctx context.Context, source, id string) (model.Row, error) {
	var document model.Row
	err := s.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) (err error) {
		document, err = reader.LoadDocument(ctx, source, id)
		return err
	})
	return document, err
}

func (r *readTransaction) LoadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	_ = definition
	s, tx := r.store, r.tx
	if isCanonicalSource(name) {
		canonical, found, readErr := readCanonical(ctx, tx, s.namespace, name)
		if readErr != nil {
			return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres canonical rows: %w", readErr)
		}
		var typed bool
		var expected sql.NullInt64
		if readErr = tx.QueryRowContext(ctx, `SELECT s.is_canonical, c.count FROM cao_sources s
			LEFT JOIN cao_counts c ON c.namespace = s.namespace AND c.source_name = s.source_name
			WHERE s.namespace = $1 AND s.source_name = $2`, s.namespace, name).Scan(&typed, &expected); readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
			return model.Source{}, model.Metrics{}, readErr
		}
		if found || typed {
			if !typed || !expected.Valid || expected.Int64 != int64(len(canonical)) {
				return model.Source{}, model.Metrics{}, errors.New("incomplete postgres canonical source")
			}
			if canonical == nil {
				canonical = []model.Row{}
			}
			result := model.Source{Source: name, Rows: canonical}
			if result.Metadata, readErr = readCanonicalMetadata(ctx, tx, s.namespace, name); readErr != nil {
				return model.Source{}, model.Metrics{}, readErr
			}
			return result, model.Metrics{OutputRows: len(canonical)}, nil
		}
		if readErr == nil {
			return model.Source{}, model.Metrics{}, errors.New("invalid postgres canonical source classification")
		}
	}
	// Schemaless sources use documents alone.
	var metadataText string
	docErr := tx.QueryRowContext(ctx, `SELECT payload FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2 AND ordinal = -1`, s.namespace, name).Scan(&metadataText)
	if docErr == nil && !isCanonicalSource(name) {
		var expected int
		if err := tx.QueryRowContext(ctx, `SELECT count FROM cao_counts WHERE namespace = $1 AND source_name = $2`,
			s.namespace, name).Scan(&expected); err != nil {
			return model.Source{}, model.Metrics{}, err
		}
		source := model.Source{Source: name, Rows: make([]model.Row, 0, expected)}
		if err := decodeJSON([]byte(metadataText), &source.Metadata); err != nil {
			return model.Source{}, model.Metrics{}, err
		}
		docRows, err := tx.QueryContext(ctx, `SELECT ordinal, payload FROM cao_source_documents
			WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0 ORDER BY ordinal`, s.namespace, name)
		if err != nil {
			return model.Source{}, model.Metrics{}, err
		}
		defer func() { _ = docRows.Close() }()
		for docRows.Next() {
			var ordinal int
			var payload string
			if err = docRows.Scan(&ordinal, &payload); err != nil {
				break
			}
			if ordinal != len(source.Rows) {
				err = errors.New("incomplete postgres document source")
				break
			}
			var row model.Row
			if err = decodeJSON([]byte(payload), &row); err != nil || row == nil {
				err = errors.New("invalid postgres document row")
				break
			}
			source.Rows = append(source.Rows, row)
		}
		if err == nil {
			err = docRows.Err()
		}
		if err != nil || len(source.Rows) != expected {
			return model.Source{}, model.Metrics{}, errors.New("incomplete postgres document source")
		}
		return source, model.Metrics{OutputRows: len(source.Rows)}, nil
	}
	if docErr != nil && !errors.Is(docErr, sql.ErrNoRows) {
		return model.Source{}, model.Metrics{}, docErr
	}
	var found bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_sources
		WHERE namespace = $1 AND source_name = $2)`, s.namespace, name).Scan(&found); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres source registry: %w", err)
	}
	if !found {
		return model.Source{}, model.Metrics{}, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	return model.Source{}, model.Metrics{}, errors.New("incomplete postgres source metadata")
}

func (r *readTransaction) LoadDocument(ctx context.Context, source, id string) (model.Row, error) {
	if isCanonicalSource(source) {
		return nil, fmt.Errorf("%w: canonical source %q has no document reader", ErrSourceUnavailable, source)
	}
	var payload string
	err := r.tx.QueryRowContext(ctx, `SELECT payload FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2 AND id = $3
		ORDER BY ordinal LIMIT 1`, r.store.namespace, source, id).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: %q document %q", ErrSourceUnavailable, source, id)
	}
	if err != nil {
		return nil, fmt.Errorf("read postgres source document: %w", err)
	}
	var document model.Row
	if err := decodeJSON([]byte(payload), &document); err != nil {
		return nil, fmt.Errorf("decode postgres source document: %w", err)
	}
	return document, nil
}

func (s *Store) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	var diagnostics model.Diagnostics
	err := s.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) (err error) {
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
