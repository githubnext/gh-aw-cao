// Package postgres implements durable, deployment-scoped operational services.
// Its tables and lifecycle are independent of the canonical dashboard database.
package postgres

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresconn"
)

//go:embed schema.sql
var schema string

var ErrInvalid = errors.New("invalid postgres operational input")

type Config struct {
	MaxCacheEntries     int64
	MaxCacheBytes       int64
	MaxCacheValueBytes  int64
	MaxProtectedEntries int64
	MaxProtectedBytes   int64
	MaxRecordBytes      int64
}

func (c Config) resolve() (Config, error) {
	for _, p := range []struct {
		value    *int64
		fallback int64
	}{
		{&c.MaxCacheEntries, 1024}, {&c.MaxCacheBytes, 32 << 20},
		{&c.MaxCacheValueBytes, 4 << 20}, {&c.MaxProtectedEntries, 200000},
		{&c.MaxProtectedBytes, 128 << 20}, {&c.MaxRecordBytes, 1 << 20},
	} {
		if *p.value < 0 {
			return c, invalid("negative capacity")
		}
		if *p.value == 0 {
			*p.value = p.fallback
		}
	}
	if c.MaxCacheValueBytes > c.MaxCacheBytes {
		return c, invalid("cache value budget exceeds cache budget")
	}
	return c, nil
}

type Store struct {
	db        *sql.DB
	namespace string
	config    Config
}

var _ operational.Store = (*Store)(nil)

func New(ctx context.Context, dsn, namespace string, config Config) (*Store, error) {
	return open(ctx, dsn, namespace, config, true)
}

// Open inspects an existing namespace without creating tables or state.
func Open(ctx context.Context, dsn, namespace string, config Config) (*Store, error) {
	return open(ctx, dsn, namespace, config, false)
}

func open(ctx context.Context, dsn, namespace string, config Config, initialize bool) (*Store, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, invalid("connection configuration is required")
	}
	if err := names(namespace); err != nil {
		return nil, err
	}
	config, err := config.resolve()
	if err != nil {
		return nil, err
	}
	connection, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, invalid("connection configuration")
	}
	if err := postgresconn.ValidateTransport(connection); err != nil {
		return nil, err
	}
	db := stdlib.OpenDB(*connection)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	s := &Store{db: db, namespace: namespace, config: config}
	if initialize {
		err = s.initialize(ctx)
	} else {
		err = s.checkConfig(ctx, db)
	}
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize postgres operational storage: %w", err)
	}
	return s, nil
}

func (s *Store) initialize(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Serialize first-use DDL across independent processes, not canonical writes.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(712083241, 17485)`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	config, err := json.Marshal(s.config)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO cao_operational_namespaces(namespace,config) VALUES ($1,$2) ON CONFLICT DO NOTHING`, s.namespace, config); err != nil {
		return err
	}
	if err := s.checkConfig(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) checkConfig(ctx context.Context, reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) error {
	var version int
	var stored []byte
	if err := reader.QueryRowContext(ctx, `SELECT version,config FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&version, &stored); err != nil {
		return err
	}
	if version != 1 {
		return operational.ErrUnsupported
	}
	config, err := json.Marshal(s.config)
	if err != nil {
		return err
	}
	if !bytes.Equal(config, stored) {
		return invalid("namespace capacity configuration differs from existing deployment")
	}
	return nil
}

func invalid(message string) error { return fmt.Errorf("%s: %w", message, ErrInvalid) }

func names(values ...string) error {
	for _, v := range values {
		if strings.TrimSpace(v) == "" || len(v) > 1024 || strings.ContainsRune(v, 0) {
			return invalid("empty, oversized, or NUL-containing name")
		}
	}
	return nil
}

func opaque(value string) error {
	if len(value) > 1024 || strings.ContainsRune(value, 0) {
		return invalid("invalid opaque namespace")
	}
	return nil
}

func ttlValid(ttl time.Duration) error {
	if ttl < time.Millisecond {
		return invalid("TTL must be at least one millisecond")
	}
	return nil
}

type key struct{ kind, name, field string }
type record struct {
	key
	value    []byte
	position int64
}
type transaction struct {
	*Store
	tx  *sql.Tx
	ctx context.Context
	now time.Time
}

// One namespace row serializes multi-record transitions and budget accounting.
// No locks are held while a queue reader waits for work.
func (s *Store) transact(ctx context.Context, fn func(*transaction) error) error {
	if ctx == nil {
		return invalid("nil context")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var namespace string
	if err := tx.QueryRowContext(ctx, `SELECT namespace FROM cao_operational_namespaces WHERE namespace=$1 FOR UPDATE`, s.namespace).Scan(&namespace); err != nil {
		return err
	}
	t := &transaction{Store: s, tx: tx, ctx: ctx}
	if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&t.now); err != nil {
		return err
	}
	t.now = t.now.UTC().Truncate(time.Millisecond)
	if err := fn(t); err != nil {
		return err
	}
	return tx.Commit()
}

func (t *transaction) get(k key) ([]byte, error) {
	var value []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT value FROM cao_operational_records WHERE namespace=$1 AND kind=$2 AND name=$3 AND field=$4 AND (expires_at IS NULL OR expires_at>$5)`,
		t.namespace, k.kind, k.name, k.field, t.now).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return value, err
}

func charge(k key, value []byte) int64 {
	return 128 + int64(len(k.kind)+len(k.name)+len(k.field)+len(value))
}

func (t *transaction) put(k key, value []byte, expires time.Time) error {
	if int64(len(value)) > t.config.MaxRecordBytes {
		return invalid("record exceeds payload limit")
	}
	if value == nil {
		value = []byte{}
	}
	var oldBytes int64
	err := t.tx.QueryRowContext(t.ctx, `SELECT octet_length(value) FROM cao_operational_records WHERE namespace=$1 AND kind=$2 AND name=$3 AND field=$4`, t.namespace, k.kind, k.name, k.field).Scan(&oldBytes)
	added := int64(0)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		added, oldBytes = 1, 0
	case err != nil:
		return err
	default:
		oldBytes += charge(k, nil)
	}
	delta := charge(k, value) - oldBytes
	result, err := t.tx.ExecContext(t.ctx, `UPDATE cao_operational_namespaces SET protected_bytes=protected_bytes+$2, protected_entries=protected_entries+$3 WHERE namespace=$1 AND protected_bytes+$2<=$4 AND protected_entries+$3<=$5`,
		t.namespace, delta, added, t.config.MaxProtectedBytes, t.config.MaxProtectedEntries)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return operational.ErrCapacity
	}
	var expiry any
	if !expires.IsZero() {
		expiry = expires
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO cao_operational_records(namespace,kind,name,field,value,expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,kind,name,field) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
		t.namespace, k.kind, k.name, k.field, value, expiry)
	return err
}

func (t *transaction) remove(k key) error {
	var size int64
	err := t.tx.QueryRowContext(t.ctx, `DELETE FROM cao_operational_records WHERE namespace=$1 AND kind=$2 AND name=$3 AND field=$4 RETURNING octet_length(value)`, t.namespace, k.kind, k.name, k.field).Scan(&size)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `UPDATE cao_operational_namespaces SET protected_bytes=protected_bytes-$2,protected_entries=protected_entries-1 WHERE namespace=$1`, t.namespace, size+charge(k, nil))
	return err
}

func (t *transaction) list(kind, name string) ([]record, error) {
	rows, err := t.tx.QueryContext(t.ctx, `SELECT name,field,value,position FROM cao_operational_records WHERE namespace=$1 AND kind=$2 AND ($3='' OR name=$3) AND (expires_at IS NULL OR expires_at>$4) ORDER BY position`, t.namespace, kind, name, t.now)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []record
	for rows.Next() {
		r := record{key: key{kind: kind}}
		if err := rows.Scan(&r.name, &r.field, &r.value, &r.position); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (t *transaction) putJSON(k key, value any, expires time.Time) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return t.put(k, data, expires)
}

func (t *transaction) json(k key, target any) (bool, error) {
	data, err := t.get(k)
	if err != nil || data == nil {
		return false, err
	}
	if err := json.Unmarshal(data, target); err != nil {
		return false, fmt.Errorf("corrupt operational record: %w", err)
	}
	return true, nil
}

func (s *Store) Capabilities() operational.Capabilities {
	c := operational.Capability{Scope: operational.ScopeDeployment, Persistence: operational.PersistenceRestart}
	return operational.Capabilities{Cache: c, RequestLimits: c, Sessions: c, Revocations: c,
		GitHubQuota: c, Collection: c, Coordination: c, Diagnostics: c}
}

func (s *Store) OperationalServices() operational.OperationalServices {
	return operational.OperationalServices{
		Backend: s, Cache: s, RequestLimiter: s, Sessions: s,
		SessionInvalidator: s, Revocations: s, Leases: s, State: s,
		Deliveries: s, Queue: s, Admission: s, Collection: s,
		GitHubQuota: s, RateLimits: s, Health: s, IngestionMetrics: s,
	}
}

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }
func (s *Store) Close() error                   { return s.db.Close() }

// DeleteNamespace removes only this operational namespace, never entity data.
func (s *Store) DeleteNamespace(ctx context.Context) error {
	return s.transact(ctx, func(t *transaction) error {
		_, err := t.tx.ExecContext(ctx, `DELETE FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace)
		return err
	})
}

func (s *Store) Health(ctx context.Context) (operational.Health, error) {
	health := operational.Health{Capabilities: s.Capabilities()}
	err := s.transact(ctx, func(t *transaction) error {
		return t.tx.QueryRowContext(ctx, `SELECT protected_entries+(SELECT count(*) FROM cao_operational_cache WHERE namespace=$1), (SELECT coalesce(sum(octet_length(value)+octet_length(key)+128),0) FROM cao_operational_cache WHERE namespace=$1) FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&health.Entries, &health.CacheBytes)
	})
	health.Ready = err == nil
	return health, err
}

func (s *Store) Maintain(ctx context.Context) error {
	return s.transact(ctx, func(t *transaction) error {
		expired, err := t.expiredKeys()
		if err != nil {
			return err
		}
		for _, k := range expired {
			if err := t.remove(k); err != nil {
				return err
			}
		}
		_, err = t.tx.ExecContext(ctx, `DELETE FROM cao_operational_cache WHERE namespace=$1 AND key IN (SELECT key FROM cao_operational_cache WHERE namespace=$1 AND expires_at<=$2 LIMIT 512)`, s.namespace, t.now)
		return err
	})
}

func (t *transaction) expiredKeys() ([]key, error) {
	rows, err := t.tx.QueryContext(t.ctx, `SELECT kind,name,field FROM cao_operational_records WHERE namespace=$1 AND expires_at<=$2 ORDER BY expires_at LIMIT 512`, t.namespace, t.now)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var expired []key
	for rows.Next() {
		var k key
		if err := rows.Scan(&k.kind, &k.name, &k.field); err != nil {
			return nil, err
		}
		expired = append(expired, k)
	}
	return expired, rows.Err()
}
