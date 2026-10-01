package postgresx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/githubnext/gh-aw-cao/server/internal/analytical"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

const schemaVersion = 1

const defaultQueryTimeout = 15 * time.Second
const defaultSnapshotRetention = 3
const snapshotRetentionGrace = 10 * time.Minute

type Options struct {
	MaxConns     int32
	MinConns     int32
	QueryTimeout time.Duration
}

type Store struct {
	pool         *pgxpool.Pool
	queryTimeout time.Duration
}

var (
	_ analytical.CanonicalStore = (*Store)(nil)
	_ analytical.SnapshotReader = (*Store)(nil)
	_ analytical.QueryExecutor  = (*Store)(nil)
)

func New(ctx context.Context, connectionString string, options Options) (*Store, error) {
	if strings.TrimSpace(connectionString) == "" {
		return nil, errors.New("PostgreSQL connection string is required")
	}
	config, err := pgxpool.ParseConfig(connectionString)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	if options.MaxConns < 0 || options.MinConns < 0 ||
		(options.MaxConns > 0 && options.MinConns > options.MaxConns) {
		return nil, errors.New("invalid PostgreSQL connection pool limits")
	}
	if options.MaxConns > 0 {
		config.MaxConns = options.MaxConns
	}
	if options.MinConns > 0 {
		config.MinConns = options.MinConns
	}
	config.ConnConfig.RuntimeParams["application_name"] = "cao-dashboard"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, errors.New("configure PostgreSQL connection pool")
	}
	store := &Store{pool: pool, queryTimeout: options.QueryTimeout}
	if store.queryTimeout <= 0 {
		store.queryTimeout = defaultQueryTimeout
	}
	startup, cancel := store.withTimeout(ctx)
	defer cancel()
	if err := pool.Ping(startup); err != nil {
		pool.Close()
		return nil, errors.New("connect to PostgreSQL")
	}
	if err := store.migrate(startup); err != nil {
		pool.Close()
		return nil, fmt.Errorf("initialize PostgreSQL schema: %w", err)
	}
	return store, nil
}

func (store *Store) Close() {
	store.pool.Close()
}

func (store *Store) Ping(ctx context.Context) error {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	if err := store.pool.Ping(ctx); err != nil {
		return errors.New("PostgreSQL health check failed")
	}
	return nil
}

func (store *Store) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, store.queryTimeout)
}

func (store *Store) migrate(ctx context.Context) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(0x43414f)); err != nil {
		return err
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS cao_schema_version (
			singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
			version integer NOT NULL
		)`,
		`INSERT INTO cao_schema_version (singleton, version) VALUES (true, 0)
			ON CONFLICT (singleton) DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS cao_projection_snapshots (
			snapshot_id text PRIMARY KEY,
			status text NOT NULL CHECK (status IN ('staging', 'active', 'retired')),
			data_revision text NOT NULL DEFAULT '',
			evaluated_at timestamptz NOT NULL DEFAULT 'epoch',
			activated_at timestamptz,
			counts jsonb NOT NULL DEFAULT '{}'::jsonb,
			created_at timestamptz NOT NULL DEFAULT clock_timestamp()
		)`,
		`CREATE INDEX IF NOT EXISTS cao_projection_snapshots_retention
			ON cao_projection_snapshots (status, activated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS cao_projection_sources (
			snapshot_id text NOT NULL REFERENCES cao_projection_snapshots(snapshot_id) ON DELETE CASCADE,
			source_name text NOT NULL,
			metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
			PRIMARY KEY (snapshot_id, source_name)
		)`,
		`CREATE TABLE IF NOT EXISTS cao_projection_rows (
			snapshot_id text NOT NULL,
			source_name text NOT NULL,
			ordinal bigint NOT NULL CHECK (ordinal >= 0),
			raw jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
			PRIMARY KEY (snapshot_id, source_name, ordinal),
			FOREIGN KEY (snapshot_id, source_name)
				REFERENCES cao_projection_sources(snapshot_id, source_name) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS cao_active_projection (
			singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
			snapshot_id text NOT NULL REFERENCES cao_projection_snapshots(snapshot_id),
			revision bigint NOT NULL CHECK (revision > 0)
		)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return err
		}
	}
	var currentVersion int
	if err := tx.QueryRow(ctx, "SELECT version FROM cao_schema_version WHERE singleton = true").Scan(&currentVersion); err != nil {
		return err
	}
	if currentVersion > schemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d", currentVersion, schemaVersion)
	}
	if currentVersion < schemaVersion {
		if _, err := tx.Exec(ctx, "UPDATE cao_schema_version SET version = $1 WHERE singleton = true", schemaVersion); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (store *Store) BeginSnapshot(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("snapshot identifier is required")
	}
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	_, err := store.pool.Exec(ctx,
		"INSERT INTO cao_projection_snapshots (snapshot_id, status) VALUES ($1, 'staging')", id)
	if err != nil {
		return errors.New("begin PostgreSQL projection snapshot")
	}
	return nil
}

func (store *Store) WriteSource(ctx context.Context, snapshotID string, source model.Source) error {
	if strings.TrimSpace(snapshotID) == "" || strings.TrimSpace(source.Source) == "" {
		return errors.New("snapshot and source identifiers are required")
	}
	if source.Metadata == nil {
		source.Metadata = model.Metadata{}
	}
	metadata, err := json.Marshal(source.Metadata)
	if err != nil {
		return fmt.Errorf("encode source metadata: %w", err)
	}
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return errors.New("begin PostgreSQL source write")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var status string
	if err := tx.QueryRow(ctx,
		"SELECT status FROM cao_projection_snapshots WHERE snapshot_id = $1 FOR UPDATE", snapshotID,
	).Scan(&status); err != nil || status != "staging" {
		return errors.New("projection snapshot is unavailable or not in staging")
	}
	if _, err := tx.Exec(ctx,
		"INSERT INTO cao_projection_sources (snapshot_id, source_name, metadata) VALUES ($1, $2, $3::jsonb)",
		snapshotID, source.Source, metadata); err != nil {
		return errors.New("write PostgreSQL source metadata")
	}
	var sourceCount int
	if err := tx.QueryRow(ctx,
		"SELECT count(*) FROM cao_projection_sources WHERE snapshot_id = $1 AND source_name = $2",
		snapshotID, source.Source).Scan(&sourceCount); err != nil {
		return errors.New("validate PostgreSQL source metadata")
	}
	if sourceCount != 1 {
		return errors.New("projection snapshot is unavailable or source already exists")
	}
	if len(source.Rows) > 0 {
		_, err = tx.CopyFrom(ctx,
			pgx.Identifier{"cao_projection_rows"},
			[]string{"snapshot_id", "source_name", "ordinal", "raw"},
			pgx.CopyFromSlice(len(source.Rows), func(index int) ([]any, error) {
				if source.Rows[index] == nil {
					return nil, fmt.Errorf("source row %d is not an object", index)
				}
				row, err := json.Marshal(source.Rows[index])
				if err != nil {
					return nil, fmt.Errorf("encode source row %d: %w", index, err)
				}
				return []any{snapshotID, source.Source, int64(index), row}, nil
			}),
		)
		if err != nil {
			return errors.New("bulk write PostgreSQL source rows")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit PostgreSQL source write")
	}
	return nil
}

func (store *Store) ValidateSnapshot(ctx context.Context, id string, expected map[string]int) error {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	return validateSnapshot(ctx, store.pool, id, expected)
}

type snapshotQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func validateSnapshot(ctx context.Context, db snapshotQuerier, id string, expected map[string]int) error {
	var status string
	if err := db.QueryRow(ctx,
		"SELECT status FROM cao_projection_snapshots WHERE snapshot_id = $1", id).Scan(&status); err != nil {
		return errors.New("projection snapshot is unavailable")
	}
	if status != "staging" {
		return errors.New("projection snapshot is not in staging")
	}
	rows, err := db.Query(ctx, `
		SELECT source.source_name, count(row.ordinal)
		FROM cao_projection_sources AS source
		LEFT JOIN cao_projection_rows AS row
			ON row.snapshot_id = source.snapshot_id AND row.source_name = source.source_name
		WHERE source.snapshot_id = $1
		GROUP BY source.source_name
		ORDER BY source.source_name`, id)
	if err != nil {
		return errors.New("read PostgreSQL snapshot counts")
	}
	defer rows.Close()
	actual := make(map[string]int)
	for rows.Next() {
		var name string
		var count int
		if err := rows.Scan(&name, &count); err != nil {
			return errors.New("decode PostgreSQL snapshot counts")
		}
		actual[name] = count
	}
	if err := rows.Err(); err != nil {
		return errors.New("read PostgreSQL snapshot counts")
	}
	if len(actual) != len(expected) {
		return errors.New("PostgreSQL snapshot source set does not match expected sources")
	}
	for name, count := range expected {
		if count < 0 || actual[name] != count {
			return fmt.Errorf("PostgreSQL snapshot count mismatch for source %q", name)
		}
	}
	return nil
}

func (store *Store) ActivateSnapshot(
	ctx context.Context, id, dataRevision string, evaluatedAt time.Time, counts map[string]int,
) (analytical.Snapshot, error) {
	if strings.TrimSpace(id) == "" {
		return analytical.Snapshot{}, errors.New("snapshot identifier is required")
	}
	if counts == nil {
		counts = map[string]int{}
	}
	encodedCounts, err := json.Marshal(counts)
	if err != nil {
		return analytical.Snapshot{}, errors.New("encode PostgreSQL snapshot counts")
	}
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return analytical.Snapshot{}, errors.New("begin PostgreSQL snapshot activation")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(0x43414f+1)); err != nil {
		return analytical.Snapshot{}, errors.New("lock PostgreSQL snapshot activation")
	}
	if err := validateSnapshot(ctx, tx, id, counts); err != nil {
		return analytical.Snapshot{}, err
	}
	var previousID *string
	if err := tx.QueryRow(ctx,
		"SELECT snapshot_id FROM cao_active_projection WHERE singleton = true FOR UPDATE").Scan(&previousID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return analytical.Snapshot{}, errors.New("read active PostgreSQL projection")
	}
	now := time.Now().UTC()
	if evaluatedAt.IsZero() {
		evaluatedAt = now
	}
	tag, err := tx.Exec(ctx, `
		UPDATE cao_projection_snapshots
		SET status = 'active', data_revision = $2, evaluated_at = $3, activated_at = $4, counts = $5::jsonb
		WHERE snapshot_id = $1 AND status = 'staging'`,
		id, dataRevision, evaluatedAt.UTC(), now, encodedCounts)
	if err != nil {
		return analytical.Snapshot{}, errors.New("mark PostgreSQL snapshot active")
	}
	if tag.RowsAffected() != 1 {
		return analytical.Snapshot{}, errors.New("PostgreSQL snapshot is no longer in staging")
	}
	var revision int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO cao_active_projection (singleton, snapshot_id, revision)
		VALUES (true, $1, 1)
		ON CONFLICT (singleton) DO UPDATE
		SET snapshot_id = EXCLUDED.snapshot_id,
			revision = cao_active_projection.revision + 1
		RETURNING revision`, id).Scan(&revision); err != nil {
		return analytical.Snapshot{}, errors.New("activate PostgreSQL projection snapshot")
	}
	if previousID != nil && *previousID != id {
		if _, err := tx.Exec(ctx,
			"UPDATE cao_projection_snapshots SET status = 'retired' WHERE snapshot_id = $1", *previousID); err != nil {
			return analytical.Snapshot{}, errors.New("retire previous PostgreSQL snapshot")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return analytical.Snapshot{}, errors.New("commit PostgreSQL snapshot activation")
	}
	return analytical.Snapshot{
		ID: id, Revision: revision, DataRevision: dataRevision,
		EvaluatedAt: evaluatedAt.UTC(), ActivatedAt: now, Counts: counts,
	}, nil
}

func (store *Store) ActiveSnapshot(ctx context.Context) (analytical.Snapshot, error) {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	var snapshot analytical.Snapshot
	var counts []byte
	err := store.pool.QueryRow(ctx, `
		SELECT snapshot.snapshot_id, active.revision, snapshot.data_revision,
			snapshot.evaluated_at, snapshot.activated_at, snapshot.counts
		FROM cao_active_projection AS active
		JOIN cao_projection_snapshots AS snapshot USING (snapshot_id)
		WHERE active.singleton = true`).Scan(
		&snapshot.ID, &snapshot.Revision, &snapshot.DataRevision,
		&snapshot.EvaluatedAt, &snapshot.ActivatedAt, &counts)
	if errors.Is(err, pgx.ErrNoRows) {
		return analytical.Snapshot{}, nil
	}
	if err != nil {
		return analytical.Snapshot{}, errors.New("read active PostgreSQL projection")
	}
	if err := json.Unmarshal(counts, &snapshot.Counts); err != nil {
		return analytical.Snapshot{}, errors.New("decode active PostgreSQL projection counts")
	}
	return snapshot, nil
}

func (store *Store) DeleteSnapshot(ctx context.Context, id string) error {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	tag, err := store.pool.Exec(ctx, `
		DELETE FROM cao_projection_snapshots AS snapshot
		WHERE snapshot.snapshot_id = $1
			AND NOT EXISTS (
				SELECT 1 FROM cao_active_projection AS active
				WHERE active.snapshot_id = snapshot.snapshot_id
			)`, id)
	if err != nil {
		return errors.New("delete PostgreSQL projection snapshot")
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := store.pool.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM cao_projection_snapshots WHERE snapshot_id = $1)", id).Scan(&exists); err != nil {
			return errors.New("check PostgreSQL projection snapshot")
		}
		if exists {
			return errors.New("cannot delete the active PostgreSQL snapshot")
		}
	}
	return nil
}

func (store *Store) PruneSnapshots(ctx context.Context, retain int) (int, error) {
	if retain < 1 {
		retain = defaultSnapshotRetention
	}
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return 0, errors.New("begin PostgreSQL snapshot cleanup")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(0x43414f+1)); err != nil {
		return 0, errors.New("lock PostgreSQL snapshot cleanup")
	}
	tag, err := tx.Exec(ctx, `
		WITH ranked AS (
			SELECT snapshot_id,
				row_number() OVER (ORDER BY activated_at DESC, snapshot_id DESC) AS position
			FROM cao_projection_snapshots
			WHERE activated_at IS NOT NULL
		)
		DELETE FROM cao_projection_snapshots AS snapshot
		USING ranked
		WHERE snapshot.snapshot_id = ranked.snapshot_id
			AND ranked.position > $1
			AND snapshot.status = 'retired'
			AND snapshot.activated_at < clock_timestamp() - ($2 * interval '1 second')
			AND NOT EXISTS (
				SELECT 1 FROM cao_active_projection AS active
				WHERE active.snapshot_id = snapshot.snapshot_id
			)`,
		retain, snapshotRetentionGrace.Seconds())
	if err != nil {
		return 0, errors.New("reclaim obsolete PostgreSQL snapshots")
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, errors.New("commit PostgreSQL snapshot cleanup")
	}
	return int(tag.RowsAffected()), nil
}

func (store *Store) Source(ctx context.Context, snapshotID, sourceName string) (model.Source, error) {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	var metadata []byte
	if err := store.pool.QueryRow(ctx,
		"SELECT metadata FROM cao_projection_sources WHERE snapshot_id = $1 AND source_name = $2",
		snapshotID, sourceName).Scan(&metadata); err != nil {
		return model.Source{}, errors.New("read PostgreSQL source metadata")
	}
	source := model.Source{Source: sourceName, Rows: []model.Row{}, Metadata: model.Metadata{}}
	if err := json.Unmarshal(metadata, &source.Metadata); err != nil {
		return model.Source{}, errors.New("decode PostgreSQL source metadata")
	}
	rows, err := store.pool.Query(ctx, `
		SELECT raw FROM cao_projection_rows
		WHERE snapshot_id = $1 AND source_name = $2
		ORDER BY ordinal`, snapshotID, sourceName)
	if err != nil {
		return model.Source{}, errors.New("read PostgreSQL source rows")
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var row model.Row
		if err := rows.Scan(&raw); err != nil {
			return model.Source{}, errors.New("decode PostgreSQL source row")
		}
		if err := json.Unmarshal(raw, &row); err != nil {
			return model.Source{}, errors.New("decode PostgreSQL source row")
		}
		source.Rows = append(source.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return model.Source{}, errors.New("read PostgreSQL source rows")
	}
	return source, nil
}

func (store *Store) Sources(ctx context.Context, snapshotID string) ([]string, error) {
	ctx, cancel := store.withTimeout(ctx)
	defer cancel()
	rows, err := store.pool.Query(ctx,
		"SELECT source_name FROM cao_projection_sources WHERE snapshot_id = $1 ORDER BY source_name", snapshotID)
	if err != nil {
		return nil, errors.New("list PostgreSQL snapshot sources")
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, errors.New("decode PostgreSQL source name")
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("list PostgreSQL snapshot sources")
	}
	return names, nil
}
