// Package sqlite is a single-host, file-backed store for local debugging of
// hosted CLI actions. It provides the CLI command queue, encrypted token
// cleanup journal, and tamper-evident audit table, so `serve-hosted` and `execute-cli` on one
// machine can share them without PostgreSQL. It is not a production backend:
// it has no namespace isolation, capacity accounting, or replication.
package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

//go:embed schema.sql
var schema string

// ErrInvalid reports invalid input to the SQLite store.
var ErrInvalid = errors.New("invalid sqlite operational input")

func invalid(message string) error { return fmt.Errorf("%s: %w", message, ErrInvalid) }

// Store is a SQLite-backed CLI command queue and audit log.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

var _ operational.CLICommandQueues = (*Store)(nil)
var _ operational.AuditLog = (*Store)(nil)

// Open preserves the original local-debug bootstrap API. Runtime processes
// should use OpenExisting so startup cannot provision or repair the schema.
func Open(ctx context.Context, path string) (*Store, error) {
	return New(ctx, path)
}

// New explicitly provisions the local debug database, creating its file with
// mode 0600 if necessary. It never removes audit history.
func New(ctx context.Context, path string) (*Store, error) {
	return open(ctx, path, "rwc")
}

// OpenExisting opens provisioned state without creating a file, executing DDL,
// or retaining audit history. Writers serialize using BEGIN IMMEDIATE.
func OpenExisting(ctx context.Context, path string) (*Store, error) {
	return open(ctx, path, "rw")
}

// OpenReadOnly opens provisioned state using SQLite's read-only connection mode.
// Verification uses a deferred transaction and cannot acquire a write lock.
func OpenReadOnly(ctx context.Context, path string) (*Store, error) {
	return open(ctx, path, "ro")
}

func open(ctx context.Context, path, mode string) (*Store, error) {
	if ctx == nil {
		return nil, invalid("nil context")
	}
	path = strings.TrimSpace(path)
	if path == "" || strings.ContainsAny(path, "?#\x00") {
		return nil, invalid("SQLite path must be a file path without '?' or '#'")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if mode == "rwc" {
		// #nosec G304 -- the operator explicitly configures the local debugging database path.
		file, err := os.OpenFile(absolute, os.O_RDWR|os.O_CREATE, 0o600)
		if err != nil {
			return nil, fmt.Errorf("open SQLite database: %w", err)
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
	}
	query := url.Values{}
	query.Set("mode", mode)
	for _, pragma := range []string{"busy_timeout(1000)", "foreign_keys(1)", "synchronous(FULL)"} {
		query.Add("_pragma", pragma)
	}
	if mode == "rwc" {
		query.Add("_pragma", "journal_mode(WAL)")
	}
	query.Set("_txlock", "immediate")
	if mode == "ro" {
		query.Set("_txlock", "deferred")
		query.Add("_pragma", "query_only(1)")
	}
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: absolute, RawQuery: query.Encode()}).String())
	if err != nil {
		return nil, err
	}
	// One connection per process keeps in-process writers from contending
	// for the file lock; cross-process writers wait on busy_timeout.
	db.SetMaxOpenConns(1)
	store := &Store{db: db, now: time.Now}
	if mode == "rwc" {
		if err := store.transact(ctx, func(t *transaction) error {
			_, err := t.tx.ExecContext(ctx, schema)
			return err
		}); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("initialize SQLite schema: %w", err)
		}
	}
	if err := store.checkProvisioned(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open provisioned SQLite storage (run database bootstrap --store operational --sqlite PATH): %w", err)
	}
	return store, nil
}

func (s *Store) checkProvisioned(ctx context.Context) error {
	var objects int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema WHERE
		(type='table' AND name IN ('cao_operational_cli_queues','cao_operational_cli_commands',
			'cao_operational_cli_executions','cao_operational_cli_revocations','cao_operational_cli_output',
			'cao_operational_audit_events','cao_operational_audit_retention'))
		OR (type='trigger' AND name IN ('cao_operational_audit_no_update','cao_operational_audit_no_delete'))`).Scan(&objects); err != nil {
		return err
	}
	if objects != 9 {
		return errors.New("SQLite schema is not provisioned")
	}
	return nil
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

type transaction struct {
	ctx context.Context
	tx  *sql.Tx
	now time.Time
}

func (s *Store) transact(ctx context.Context, fn func(*transaction) error) error {
	if ctx == nil {
		return invalid("nil context")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(&transaction{ctx: ctx, tx: tx, now: s.now().UTC()}); err != nil {
		return err
	}
	return tx.Commit()
}

func nanos(t time.Time) int64 { return t.UTC().UnixNano() }

func fromNanos(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	t := time.Unix(0, value.Int64).UTC()
	return &t
}

func name(value string) error {
	if strings.TrimSpace(value) == "" || len(value) > 1024 || strings.ContainsRune(value, 0) {
		return invalid("empty, oversized, or NUL-containing name")
	}
	return nil
}
