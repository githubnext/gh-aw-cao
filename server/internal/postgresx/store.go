// Package postgresx stores the current dashboard sources in PostgreSQL.
package postgresx

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	_ "github.com/jackc/pgx/v5/stdlib"
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

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// New connects to PostgreSQL and initializes the current-source schema.
func New(ctx context.Context, dsn string) (*Store, error) {
	return NewWithNamespace(ctx, dsn, "default")
}

// NewWithNamespace isolates dashboard data when deployments share a database.
// New uses "default"; deployments sharing a DSN must provide distinct namespaces.
func NewWithNamespace(ctx context.Context, dsn, namespace string) (*Store, error) {
	if namespace == "" {
		return nil, errors.New("postgres namespace is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS cao_sources (
			namespace TEXT NOT NULL,
			source_name TEXT NOT NULL,
			metadata JSONB NOT NULL,
			PRIMARY KEY (namespace, source_name)
		)`,
		`CREATE TABLE IF NOT EXISTS cao_source_rows (
			namespace TEXT NOT NULL,
			source_name TEXT NOT NULL,
			ordinal BIGINT NOT NULL,
			payload JSONB NOT NULL,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS cao_state (
			namespace TEXT PRIMARY KEY,
			revision BIGINT NOT NULL,
			data_revision TEXT NOT NULL,
			evaluated_at TIMESTAMPTZ NOT NULL,
			counts JSONB NOT NULL,
			diagnostics JSONB NOT NULL
		)`,
	} {
		if _, err = db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize postgres schema: %w", err)
		}
	}
	return &Store{db: db, namespace: namespace}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// State returns an unready zero revision before the first successful replacement.
func (s *Store) State(ctx context.Context) (State, error) {
	return s.readState(ctx, s.db)
}

func (r *readTransaction) State(ctx context.Context) (State, error) {
	return r.store.readState(ctx, r.tx)
}

func (s *Store) readState(ctx context.Context, db rowQuerier) (State, error) {
	state := State{Counts: map[string]int{}}
	var counts []byte
	err := db.QueryRowContext(ctx, `SELECT revision, data_revision, evaluated_at, counts FROM cao_state WHERE namespace = $1`, s.namespace).
		Scan(&state.Revision, &state.DataRevision, &state.EvaluatedAt, &counts)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read postgres state: %w", err)
	}
	if err := json.Unmarshal(counts, &state.Counts); err != nil {
		return State{}, fmt.Errorf("decode postgres counts: %w", err)
	}
	state.Ready = true
	return state, nil
}

// Replace atomically swaps all source documents, metadata, diagnostics and state.
// The singleton state row serializes concurrent replacements.
func (s *Store) Replace(ctx context.Context, sources map[string]model.Source, diagnostics model.Diagnostics, dataRevision string, evaluatedAt time.Time) (revision int64, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin postgres replacement: %w", err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_state (namespace, revision, data_revision, evaluated_at, counts, diagnostics)
		VALUES ($1, 0, '', 'epoch'::timestamptz, '{}'::jsonb, '{}'::jsonb) ON CONFLICT (namespace) DO NOTHING`, s.namespace); err != nil {
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
	for _, name := range names {
		source := sources[name]
		if name == "" || (source.Source != "" && source.Source != name) {
			return 0, fmt.Errorf("invalid postgres source name %q", name)
		}
		metadata, marshalErr := json.Marshal(source.Metadata)
		if marshalErr != nil {
			return 0, fmt.Errorf("marshal metadata for %q: %w", name, marshalErr)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO cao_sources (namespace, source_name, metadata) VALUES ($1, $2, $3::jsonb)`, s.namespace, name, metadata); err != nil {
			return 0, fmt.Errorf("insert postgres source %q: %w", name, err)
		}
		for ordinal, row := range source.Rows {
			if row == nil {
				return 0, fmt.Errorf("nil row in postgres source %q", name)
			}
			payload, marshalErr := json.Marshal(row)
			if marshalErr != nil {
				return 0, fmt.Errorf("marshal row in %q: %w", name, marshalErr)
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO cao_source_rows (namespace, source_name, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb)`, s.namespace, name, ordinal, payload); err != nil {
				return 0, fmt.Errorf("insert postgres row in %q: %w", name, err)
			}
		}
		counts[name] = len(source.Rows)
	}
	countJSON, err := json.Marshal(counts)
	if err != nil {
		return 0, err
	}
	diagnosticsJSON, err := json.Marshal(diagnostics)
	if err != nil {
		return 0, fmt.Errorf("marshal postgres diagnostics: %w", err)
	}
	if err = tx.QueryRowContext(ctx, `UPDATE cao_state SET revision = revision + 1,
		data_revision = $1, evaluated_at = $2, counts = $3::jsonb, diagnostics = $4::jsonb
		WHERE namespace = $5 RETURNING revision`, dataRevision, evaluatedAt, countJSON, diagnosticsJSON, s.namespace).Scan(&revision); err != nil {
		return 0, fmt.Errorf("update postgres state: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit postgres replacement: %w", err)
	}
	return revision, nil
}

// WithReadTransaction keeps State, Diagnostics and every LoadSource in the
// callback at the same PostgreSQL repeatable-read snapshot. Do not retain the
// reader after the callback returns.
func (s *Store) WithReadTransaction(ctx context.Context, fn func(SourceReader) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return fmt.Errorf("begin postgres source read: %w", err)
	}
	defer tx.Rollback()
	if err := fn(&readTransaction{store: s, tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit postgres source read: %w", err)
	}
	return nil
}

// LoadSource returns complete source documents; definition is deliberately not
// pushed into SQL, so the existing Go query engine evaluates all operators.
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
	var metadataJSON []byte
	if err := tx.QueryRowContext(ctx, `SELECT metadata FROM cao_sources WHERE namespace = $1 AND source_name = $2`, s.namespace, name).Scan(&metadataJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Source{}, model.Metrics{}, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
		}
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres metadata: %w", err)
	}
	source := model.Source{Source: name, Rows: []model.Row{}}
	if err := decodeJSON(metadataJSON, &source.Metadata); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres metadata: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `SELECT payload FROM cao_source_rows WHERE namespace = $1 AND source_name = $2 ORDER BY ordinal`, s.namespace, name)
	if err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres rows: %w", err)
	}
	for rows.Next() {
		var payload []byte
		if err = rows.Scan(&payload); err != nil {
			break
		}
		var row model.Row
		err = decodeJSON(payload, &row)
		if err != nil {
			break
		}
		source.Rows = append(source.Rows, row)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres rows: %w", err)
	}
	return source, model.Metrics{OutputRows: len(source.Rows)}, nil
}

func (s *Store) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	return s.readDiagnostics(ctx, s.db)
}

func (r *readTransaction) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	return r.store.readDiagnostics(ctx, r.tx)
}

func (s *Store) readDiagnostics(ctx context.Context, db rowQuerier) (model.Diagnostics, error) {
	var payload []byte
	err := db.QueryRowContext(ctx, `SELECT diagnostics FROM cao_state WHERE namespace = $1 AND revision > 0`, s.namespace).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Diagnostics{}, nil
	}
	if err != nil {
		return model.Diagnostics{}, fmt.Errorf("read postgres diagnostics: %w", err)
	}
	var diagnostics model.Diagnostics
	if err = decodeJSON(payload, &diagnostics); err != nil {
		return model.Diagnostics{}, fmt.Errorf("decode postgres diagnostics: %w", err)
	}
	return diagnostics, nil
}

func decodeJSON(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(dest)
}
