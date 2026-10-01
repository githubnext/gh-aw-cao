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
	db *sql.DB
}

// New connects to PostgreSQL and initializes the current-source schema.
func New(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS cao_sources (
			source_name TEXT PRIMARY KEY,
			metadata JSONB NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS cao_source_rows (
			source_name TEXT NOT NULL REFERENCES cao_sources(source_name) ON DELETE CASCADE,
			ordinal BIGINT NOT NULL,
			payload JSONB NOT NULL,
			PRIMARY KEY (source_name, ordinal)
		)`,
		`CREATE TABLE IF NOT EXISTS cao_state (
			id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
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
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// State returns an unready zero revision before the first successful replacement.
func (s *Store) State(ctx context.Context) (State, error) {
	state := State{Counts: map[string]int{}}
	var counts []byte
	err := s.db.QueryRowContext(ctx, `SELECT revision, data_revision, evaluated_at, counts FROM cao_state WHERE id = TRUE`).
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
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_state (id, revision, data_revision, evaluated_at, counts, diagnostics)
		VALUES (TRUE, 0, '', 'epoch'::timestamptz, '{}'::jsonb, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`); err != nil {
		return 0, fmt.Errorf("initialize postgres state: %w", err)
	}
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM cao_state WHERE id = TRUE FOR UPDATE`).Scan(&revision); err != nil {
		return 0, fmt.Errorf("lock postgres state: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM cao_sources`); err != nil {
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
		if _, err = tx.ExecContext(ctx, `INSERT INTO cao_sources (source_name, metadata) VALUES ($1, $2::jsonb)`, name, metadata); err != nil {
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
			if _, err = tx.ExecContext(ctx, `INSERT INTO cao_source_rows (source_name, ordinal, payload) VALUES ($1, $2, $3::jsonb)`, name, ordinal, payload); err != nil {
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
		WHERE id = TRUE RETURNING revision`, dataRevision, evaluatedAt, countJSON, diagnosticsJSON).Scan(&revision); err != nil {
		return 0, fmt.Errorf("update postgres state: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit postgres replacement: %w", err)
	}
	return revision, nil
}

// LoadSource returns complete source documents; definition is deliberately not
// pushed into SQL, so the existing Go query engine evaluates all operators.
func (s *Store) LoadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	_ = definition
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("begin postgres source read: %w", err)
	}
	defer tx.Rollback()
	var metadataJSON []byte
	if err = tx.QueryRowContext(ctx, `SELECT metadata FROM cao_sources WHERE source_name = $1`, name).Scan(&metadataJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Source{}, model.Metrics{}, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
		}
		return model.Source{}, model.Metrics{}, fmt.Errorf("read postgres metadata: %w", err)
	}
	source := model.Source{Source: name, Rows: []model.Row{}}
	if err = decodeJSON(metadataJSON, &source.Metadata); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("decode postgres metadata: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `SELECT payload FROM cao_source_rows WHERE source_name = $1 ORDER BY ordinal`, name)
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
	if err = tx.Commit(); err != nil {
		return model.Source{}, model.Metrics{}, fmt.Errorf("commit postgres source read: %w", err)
	}
	return source, model.Metrics{OutputRows: len(source.Rows)}, nil
}

func (s *Store) Diagnostics(ctx context.Context) (model.Diagnostics, error) {
	var payload []byte
	err := s.db.QueryRowContext(ctx, `SELECT diagnostics FROM cao_state WHERE id = TRUE AND revision > 0`).Scan(&payload)
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
