// Package sqlite provides a durable, local-only webhook gateway queue.
// It is not a hosted operational.Store or a source of GitHub authority.
package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type Queue struct {
	db      *sql.DB
	options wg.QueueOptions
}

var _ wg.Queue = (*Queue)(nil)

const schema = `
CREATE TABLE IF NOT EXISTS gateway (
 id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL, config BLOB NOT NULL,
 revision BLOB NOT NULL, tenant_cursor TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS deliveries (
 id TEXT PRIMARY KEY, digest TEXT NOT NULL, retain_until INTEGER NOT NULL, bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_scopes (
 delivery TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, scope TEXT NOT NULL, bytes INTEGER NOT NULL,
 PRIMARY KEY(delivery,kind,scope)
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, delivery TEXT NOT NULL REFERENCES deliveries(id),
 document BLOB NOT NULL, tenant TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
 state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 not_before INTEGER NOT NULL, lease_until INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ready_jobs ON jobs(state,tenant,created_at,id);
CREATE INDEX IF NOT EXISTS delivery_jobs ON jobs(delivery);
CREATE TABLE IF NOT EXISTS rates (
 id TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);`

// Open requires a private, dedicated SQLite file. Concurrent handles use SQLite
// write transactions, rather than a process mutex, to fence all queue changes.
func Open(ctx context.Context, path, namespace string, options wg.QueueOptions) (*Queue, error) {
	if !filepath.IsAbs(path) || namespace == "" || len(namespace) > 128 {
		return nil, wg.ErrInvalid
	}
	if err := wg.ValidateQueueOptions(options); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600) // #nosec G304 G703 -- explicit operator-owned local database, never webhook input.
	if err == nil {
		err = file.Close()
	} else if errors.Is(err, os.ErrExist) {
		var info os.FileInfo
		info, err = os.Lstat(path)
		if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
			err = wg.ErrInvalid
		}
	}
	if err != nil {
		return nil, err
	}
	location := (&url.URL{Scheme: "file", Path: path}).String()
	db, err := sql.Open("sqlite", location+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(1)&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	q := &Queue{db: db, options: options}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, err
	}
	config, err := json.Marshal(options)
	if err == nil {
		err = q.transact(ctx, func(tx *sql.Tx, _ time.Time) error {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO gateway(id,namespace,config,revision) VALUES(1,?,?,?)`,
				namespace, config, []byte(`{"revision":0,"digest":"","enabled":false}`)); err != nil {
				return err
			}
			var storedNamespace string
			var storedConfig []byte
			if err := tx.QueryRowContext(ctx, `SELECT namespace,config FROM gateway WHERE id=1`).Scan(&storedNamespace, &storedConfig); err != nil {
				return err
			}
			if namespace != storedNamespace || !bytes.Equal(config, storedConfig) {
				return wg.ErrConflict
			}
			return nil
		})
	}
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return q, nil
}

func (q *Queue) Close() error { return q.db.Close() }

// HasDelivery reports only committed, retained admission receipts. The local
// poller uses these to recognize Events API IDs whose payloads may have changed.
func (q *Queue) HasDelivery(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := q.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM deliveries WHERE id=?)`, id).Scan(&exists)
	return exists, err
}

func (q *Queue) transact(ctx context.Context, apply func(*sql.Tx, time.Time) error) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var millis int64
	if err := tx.QueryRowContext(ctx, `SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)`).Scan(&millis); err != nil {
		return err
	}
	if err := apply(tx, time.UnixMilli(millis).UTC()); err != nil {
		return err
	}
	return tx.Commit()
}

func revision(ctx context.Context, tx *sql.Tx) (wg.QueueRevision, error) {
	var data []byte
	var result wg.QueueRevision
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM gateway WHERE id=1`).Scan(&data); err != nil {
		return result, err
	}
	err := json.Unmarshal(data, &result)
	return result, err
}

func load(ctx context.Context, tx *sql.Tx, id string) (wg.Job, error) {
	var data []byte
	var job wg.Job
	err := tx.QueryRowContext(ctx, `SELECT document FROM jobs WHERE id=?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return job, wg.ErrNotFound
	}
	if err != nil {
		return job, err
	}
	err = json.Unmarshal(data, &job)
	return job, err
}

func (q *Queue) save(ctx context.Context, tx *sql.Tx, now time.Time, job wg.Job) error {
	data, err := json.Marshal(job)
	if err != nil {
		return err
	}
	retain := int64(0)
	if wg.IsTerminal(job.State) {
		retain = now.Add(q.options.TerminalRetention).UnixMilli()
	}
	_, err = tx.ExecContext(ctx, `UPDATE jobs SET document=?,state=?,not_before=?,lease_until=?,retain_until=max(retain_until,?) WHERE id=?`,
		data, job.State, job.NotBefore.UnixMilli(), job.LeaseUntil.UnixMilli(), retain, job.ID)
	return err
}

func fence(job wg.Job, expected wg.Fence, now time.Time) error {
	if expected.JobID != job.ID || expected.Owner != job.ClaimID || expected.Owner == "" ||
		expected.Generation != job.Fence || expected.Version != job.Version ||
		!job.LeaseUntil.After(now) || (job.State != wg.Claimed && job.State != wg.Dispatching) {
		return wg.ErrConflict
	}
	return nil
}

func (q *Queue) ApplyRevision(ctx context.Context, next wg.QueueRevision) error {
	digest, err := hex.DecodeString(next.Digest)
	if next.Revision < 1 || err != nil || len(digest) != 32 || hex.EncodeToString(digest) != next.Digest {
		return wg.ErrInvalid
	}
	return q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if next.Revision < current.Revision || (next.Revision == current.Revision && next != current) {
			return wg.ErrConflict
		}
		if next == current {
			return nil
		}
		data, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE gateway SET revision=? WHERE id=1`, data); err != nil {
			return err
		}
		ids, err := selectIDs(ctx, tx, `SELECT id FROM jobs WHERE state IN ('ready','claimed')`)
		if err != nil {
			return err
		}
		for _, id := range ids {
			job, err := load(ctx, tx, id)
			if err != nil {
				return err
			}
			cancelled, err := wg.CancelJob(now, job, job.Version)
			if err != nil {
				return err
			}
			if err := q.save(ctx, tx, now, cancelled); err != nil {
				return err
			}
		}
		return nil
	})
}

func selectIDs(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (q *Queue) QueueDepth(ctx context.Context) (int64, error) {
	var depth int64
	err := q.db.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE state IN ('ready','claimed','dispatching')`).Scan(&depth)
	return depth, err
}

// Counts reports simulated queue outcomes without exposing payloads.
func (q *Queue) Counts(ctx context.Context) (map[wg.JobState]int64, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT state,count(*) FROM jobs GROUP BY state`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := make(map[wg.JobState]int64)
	for rows.Next() {
		var state wg.JobState
		var count int64
		if err := rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		result[state] = count
	}
	return result, rows.Err()
}
