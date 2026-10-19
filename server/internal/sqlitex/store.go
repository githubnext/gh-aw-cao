// Package sqlitex reads the local dashboard's canonical SQLite projection.
package sqlitex

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

const databaseName = "gh-aw-cao-dashboard-data"

var collections = []string{
	"campaigns", "repositories", "workflows", "runs", "domains", "tools",
	"skills", "friction", "audits", "issues", "operationalValues", "marketplacePackages",
	"experiments", "experimentAssignments", "graders", "graderObservations", "evals", "evalObservations",
}

type Store struct {
	db                *sql.DB
	database          string
	tables            map[string]bool
	inventory         map[string]model.Source
	inventoryRows     map[string][]inventoryRecord
	compilerOverrides map[string]model.Row
	native            bool
	nativeState       postgresx.State
	statePath         string
	fingerprint       string
	stateMu           sync.RWMutex
	memory            repositorymemory.Snapshot
	memoryAvailable   bool
}

type readTransaction struct {
	store *Store
	tx    *sql.Tx
	state postgresx.State
}

var _ postgresx.NativeReader = (*readTransaction)(nil)

// Open opens an existing canonical dashboard projection.
func Open(ctx context.Context, path string) (*Store, error) { return New(ctx, path) }

// New opens an existing regular SQLite file prepared by canonical ingestion.
// It never creates a missing database or interprets a path as a SQLite URI.
func New(ctx context.Context, path string) (*Store, error) {
	if path == "" || strings.ContainsRune(path, '\x00') {
		return nil, errors.New("local SQLite database path is required")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("local SQLite database must be an existing regular file")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return nil, errors.New("local SQLite database path must not traverse a symbolic link")
	}
	dsn := url.URL{Scheme: "file", Path: path}
	parameters := url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(5000)"}}
	dsn.RawQuery = parameters.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	store := &Store{db: db, tables: map[string]bool{}, inventory: map[string]model.Source{}}
	fail := func(err error) (*Store, error) { _ = db.Close(); return nil, err }
	if err := db.PingContext(ctx); err != nil {
		return fail(fmt.Errorf("open local SQLite database: %w", err))
	}
	tables, err := readStringColumn(ctx, db, `SELECT name FROM sqlite_schema WHERE type='table'`)
	if err != nil {
		return fail(fmt.Errorf("read canonical database schema: %w", err))
	}
	for _, name := range tables {
		store.tables[name] = true
	}
	if !store.tables["__idb_records"] {
		return fail(errors.New("local SQLite file has no canonical records table"))
	}
	databaseStatement := `SELECT DISTINCT database_name FROM __idb_records WHERE database_name = ? OR database_name LIKE ? LIMIT 2`
	if store.tables["__idb_databases"] {
		databaseStatement = `SELECT name FROM __idb_databases WHERE name = ? OR name LIKE ? ORDER BY name LIMIT 2`
	}
	names, err := readStringColumn(ctx, db, databaseStatement, databaseName, databaseName+":%")
	if err != nil {
		return fail(fmt.Errorf("read canonical database registration: %w", err))
	}
	if len(names) > 1 {
		return fail(errors.New("local SQLite file must contain exactly one canonical dashboard database"))
	}
	store.database = databaseName
	if len(names) == 1 {
		store.database = names[0]
	}
	statements := []string{`SELECT database_name,store_name,record_key,value FROM __idb_records LIMIT 0`}
	if store.tables["__idb_stores"] {
		statements = append(statements, `SELECT database_name,name FROM __idb_stores LIMIT 0`)
	}
	if store.tables["preview_sources"] {
		statements = append(statements, `SELECT name,value FROM preview_sources LIMIT 0`)
	}
	for _, statement := range statements {
		if err := validateSchema(ctx, db, statement); err != nil {
			return fail(fmt.Errorf("invalid local SQLite schema: %w", err))
		}
	}
	store.native = !store.tables["preview_sources"]
	if store.native {
		db.SetMaxOpenConns(1)
		if err := store.initializeNative(ctx, path, info); err != nil {
			return fail(err)
		}
		return store, nil
	}
	if err := db.Close(); err != nil {
		return nil, err
	}
	parameters.Set("mode", "rw")
	dsn.RawQuery = parameters.Encode()
	db, err = sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	store.db = db
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS __cao_local_state (
		database_name TEXT PRIMARY KEY, revision INTEGER NOT NULL, data_revision TEXT NOT NULL, evaluated_at TEXT NOT NULL
	)`); err != nil {
		return fail(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO __cao_local_state VALUES (?,1,'',?) ON CONFLICT(database_name) DO NOTHING`,
		store.database, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return fail(err)
	}
	return store, nil
}

func readStringColumn(ctx context.Context, db *sql.DB, statement string, arguments ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func validateSchema(ctx context.Context, db *sql.DB, statement string) error {
	rows, err := db.QueryContext(ctx, statement)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
	}
	return rows.Err()
}

func (s *Store) Open() bool { return s != nil && s.db != nil }
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// SetState persists an ingestion revision and evaluation time across restarts.
func (s *Store) SetState(ctx context.Context, state postgresx.State) error {
	if state.Revision < 1 || state.EvaluatedAt.IsZero() {
		return errors.New("local SQLite state requires a positive revision and evaluation time")
	}
	if s.native {
		if err := ctx.Err(); err != nil {
			return err
		}
		return s.setNativeState(state)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE __cao_local_state SET revision=?,data_revision=?,evaluated_at=? WHERE database_name=?`,
		state.Revision, state.DataRevision, state.EvaluatedAt.UTC().Format(time.RFC3339Nano), s.database)
	return err
}

func (s *Store) WithReadTransaction(ctx context.Context, fn func(context.Context, postgresx.NativeReader) error) error {
	if !s.Open() {
		return errors.New("local SQLite store is not open")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Acquire the snapshot before invoking the callback, including callbacks
	// which read state before resolving their first canonical source.
	reader := &readTransaction{store: s, tx: tx}
	if s.native {
		s.stateMu.RLock()
		reader.state = s.nativeState
		s.stateMu.RUnlock()
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema WHERE name='__idb_records'`).Scan(&count); err != nil {
			return err
		}
	} else {
		var revision int64
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM __cao_local_state WHERE database_name=?`, s.database).Scan(&revision); err != nil {
			return err
		}
	}
	if err := fn(ctx, reader); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) State(ctx context.Context) (state postgresx.State, err error) {
	err = s.WithReadTransaction(ctx, func(ctx context.Context, r postgresx.NativeReader) error {
		state, err = r.State(ctx)
		return err
	})
	return
}

func (r *readTransaction) State(ctx context.Context) (postgresx.State, error) {
	state := postgresx.State{Counts: map[string]int{}}
	if r.store.native {
		state.Revision, state.DataRevision, state.EvaluatedAt = r.state.Revision, r.state.DataRevision, r.state.EvaluatedAt
	} else {
		var evaluated string
		if err := r.tx.QueryRowContext(ctx, `SELECT revision,data_revision,evaluated_at FROM __cao_local_state WHERE database_name=?`,
			r.store.database).Scan(&state.Revision, &state.DataRevision, &evaluated); err != nil {
			return state, err
		}
		var err error
		state.EvaluatedAt, err = time.Parse(time.RFC3339Nano, evaluated)
		if err != nil {
			return state, err
		}
	}
	rows, err := r.tx.QueryContext(ctx, `SELECT store_name,count(*) FROM __idb_records WHERE database_name=? GROUP BY store_name`, r.store.database)
	if err != nil {
		return state, err
	}
	defer func() { _ = rows.Close() }()
	for _, name := range collections {
		state.Counts["$"+name] = 0
	}
	for rows.Next() {
		var name string
		var count int
		if err := rows.Scan(&name, &count); err != nil {
			return state, err
		}
		if _, known := state.Counts["$"+name]; known {
			state.Counts["$"+name] = count
		}
	}
	if err := rows.Err(); err != nil {
		return state, err
	}
	for collection, inventory := range r.store.inventoryRows {
		if len(inventory) == 0 {
			continue
		}
		projected, err := r.inventoryIdentities(ctx, collection)
		if err != nil {
			return state, err
		}
		enriched, err := r.store.enrichInventory(collection, projected)
		if err != nil {
			return state, err
		}
		state.Counts["$"+collection] = len(enriched)
	}
	state.Ready = state.Revision > 0
	if r.store.native {
		state.Ready = r.state.Ready
	}
	return state, nil
}

func (s *Store) ExecuteSQLPlan(ctx context.Context, definitions []query.Definition, requested []string) (sources map[string]model.Source, metrics model.Metrics, err error) {
	return s.ExecuteSQLPlanWithOptions(ctx, definitions, requested, postgresx.SQLExecutionOptions{})
}

func (s *Store) ExecuteSQLPlanWithOptions(ctx context.Context, definitions []query.Definition, requested []string, options postgresx.SQLExecutionOptions) (sources map[string]model.Source, metrics model.Metrics, err error) {
	err = s.WithReadTransaction(ctx, func(ctx context.Context, r postgresx.NativeReader) error {
		sources, metrics, err = r.ExecuteSQLPlanWithOptions(ctx, definitions, requested, options)
		return err
	})
	return
}

func decode(content string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.UseNumber()
	return decoder.Decode(target)
}
