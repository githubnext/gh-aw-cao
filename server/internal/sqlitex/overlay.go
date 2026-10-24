package sqlitex

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubnext/gh-cao/internal/dashboardquery"

	"github.com/githubnext/gh-cao/server/internal/model"
)

// OpenOverlay attaches the deployed snapshot read-only to a separate local
// database. Request connections remain query-only; ingestion uses another process.
func OpenOverlay(ctx context.Context, snapshot, overlay string, metadata map[string]model.Metadata) (*Store, error) {
	base, err := OpenWithMetadata(ctx, snapshot, metadata)
	if err != nil {
		return nil, err
	}
	state, err := base.State(ctx)
	closeErr := base.Close()
	if err := errors.Join(err, closeErr); err != nil {
		return nil, err
	}
	snapshot, err = filepath.Abs(snapshot)
	if err != nil {
		return nil, err
	}
	overlay, err = filepath.Abs(overlay)
	if err != nil {
		return nil, err
	}
	baseInfo, err := os.Stat(snapshot)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(overlay)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if snapshot == overlay || info != nil && (!info.Mode().IsRegular() || os.SameFile(baseInfo, info)) {
		return nil, errors.New("SQLite overlay must be a separate regular file, not the snapshot or a symlink")
	}
	if err := os.MkdirAll(filepath.Dir(overlay), 0o700); err != nil {
		return nil, err
	}
	if info == nil {
		// #nosec G304 -- operator-selected local delta; exclusive creation never opens an existing path.
		file, err := os.OpenFile(overlay, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", overlayDSN(overlay))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	store := &Store{
		db: db, conn: conn, metadata: metadata, snapshotRevision: state.DataRevision,
		overlayPath: overlay, readGate: make(chan struct{}, 1),
	}
	if err := store.initializeOverlay(ctx, snapshot); err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("open local SQLite overlay: %w", err)
	}
	return store, nil
}

func (s *Store) initializeOverlay(ctx context.Context, snapshot string) error {
	if _, err := s.conn.ExecContext(ctx, `ATTACH DATABASE ? AS snapshot`, snapshotDSN(snapshot)); err != nil {
		return err
	}
	var tables, owned int
	if err := s.conn.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(name='__cao_overlay_metadata'),0)
		FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&tables, &owned); err != nil {
		return err
	}
	if tables > 0 && owned != 1 {
		return errors.New("existing file is not a CAO SQLite overlay")
	}
	if _, err := s.conn.ExecContext(ctx, `PRAGMA main.journal_mode=WAL`); err != nil {
		return err
	}
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, dashboardquery.SQLiteOverlaySchema); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO __cao_overlay_metadata (id,snapshot_revision) VALUES (1,?)`, s.snapshotRevision); err != nil {
		return err
	}
	var revision string
	if err := tx.QueryRowContext(ctx, `SELECT snapshot_revision FROM __cao_overlay_metadata WHERE id=1`).Scan(&revision); err != nil {
		return err
	}
	if revision != s.snapshotRevision {
		return errors.New("overlay belongs to a different snapshot; select a new --sqlite-overlay file (the previous overlay is preserved)")
	}
	if err := storeVersion(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	_, err = s.conn.ExecContext(ctx, `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA mmap_size=1073741824`)
	return err
}

func (s *Store) SnapshotRevision() string { return s.snapshotRevision }

func overlayDSN(path string) string {
	location := &url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/")}
	location.RawQuery = url.Values{"mode": {"rw"}, "_pragma": {"busy_timeout(5000)"}}.Encode()
	return location.String()
}

// StageOverlay copies only the local delta, never the attached deployed records.
func (s *Store) StageOverlay(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", overlayDSN(s.overlayPath))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	_, err = db.ExecContext(ctx, `VACUUM main INTO ?`, path)
	return err
}

// PublishOverlay atomically activates a fully ingested local delta. Concurrent
// refreshes cannot overwrite a generation published after staging began.
func (s *Store) PublishOverlay(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", overlayDSN(s.overlayPath))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout=5000; ATTACH DATABASE ? AS staged`, snapshotDSN(path)); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var matches int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM main.__cao_overlay_metadata AS live
		JOIN staged.__cao_overlay_metadata AS staged USING(id,snapshot_revision,generation)
		WHERE live.snapshot_revision=?`, s.snapshotRevision).Scan(&matches); err != nil {
		return err
	}
	if matches != 1 {
		return errors.New("SQLite overlay changed during backfill; staged data was not published")
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM main.__idb_records;
		INSERT INTO main.__idb_records SELECT * FROM staged.__idb_records;
		DELETE FROM main.__cao_overlay_deleted;
		INSERT INTO main.__cao_overlay_deleted SELECT * FROM staged.__cao_overlay_deleted;
		UPDATE main.__cao_overlay_metadata SET generation=generation+1 WHERE id=1;
	`); err != nil {
		return err
	}
	return tx.Commit()
}
