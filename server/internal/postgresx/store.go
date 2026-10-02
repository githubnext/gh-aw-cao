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
	"reflect"
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
			payload JSON NOT NULL, id TEXT, run_id TEXT, session_id TEXT,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS cao_canonical_rows (
			namespace TEXT NOT NULL, source_name TEXT NOT NULL, ordinal BIGINT NOT NULL,
			present TEXT[] NOT NULL, extension JSON,
			id TEXT, run_id TEXT, session_id TEXT, repository_id TEXT,
			target_repository_id TEXT, workflow_id TEXT,
			status TEXT, conclusion TEXT, event TEXT,
			owner TEXT, repository TEXT, name TEXT, full_name TEXT, path TEXT,
			visibility TEXT, state TEXT, campaign TEXT, campaign_id TEXT,
			head_sha TEXT, head_branch TEXT, source TEXT, source_id TEXT,
			repository_full_name TEXT, slug TEXT, url TEXT, type TEXT,
			category TEXT, correlation_id TEXT,
			description TEXT, icon TEXT, mode TEXT, domain TEXT, decision TEXT,
			tool_type TEXT, mcp_server TEXT, mcp_tool TEXT,
			safe_output_type TEXT, github_entity_type TEXT,
			summary TEXT, payload_ref TEXT, target_repo TEXT,
			target_organization TEXT, target_repository TEXT,
			rollout_mode TEXT, campaign_name TEXT, campaign_icon TEXT,
			campaign_readme_path TEXT,
			role TEXT, workflow_path TEXT, title TEXT, branch TEXT,
			engine TEXT, engine_version TEXT, requested_model TEXT,
			resolved_model TEXT, model_id TEXT,
			created_at TIMESTAMPTZ, created_at_raw TEXT,
			started_at TIMESTAMPTZ, started_at_raw TEXT,
			completed_at TIMESTAMPTZ, completed_at_raw TEXT,
			updated_at TIMESTAMPTZ, updated_at_raw TEXT,
			observed_at TIMESTAMPTZ, observed_at_raw TEXT,
			timestamp_at TIMESTAMPTZ, timestamp_at_raw TEXT,
			attempt NUMERIC, attempt_raw TEXT,
			sequence NUMERIC, sequence_raw TEXT,
			issue_number NUMERIC, issue_number_raw TEXT,
			duration_ms NUMERIC, duration_ms_raw TEXT,
			request_count NUMERIC, request_count_raw TEXT,
			worker_count NUMERIC, worker_count_raw TEXT,
			aic_total NUMERIC, aic_total_raw TEXT,
			enabled BOOLEAN, is_skill BOOLEAN, is_pull_request BOOLEAN,
			github_id TEXT, github_id_kind TEXT, github_id_numeric NUMERIC,
			github_run_id TEXT, github_run_id_kind TEXT, github_run_id_numeric NUMERIC,
			organization_href TEXT, repository_href TEXT, workflow_href TEXT, run_href TEXT,
			contents TEXT[], contents_exception JSON,
			CONSTRAINT cao_canonical_github_id_kind CHECK (COALESCE(
				(github_id IS NULL AND github_id_kind IS NULL AND github_id_numeric IS NULL) OR
				(github_id_kind = 'string' AND github_id IS NOT NULL AND github_id_numeric IS NULL) OR
				(github_id_kind = 'number' AND
					(github_id IS NOT NULL OR github_id_numeric IS NOT NULL)), FALSE)),
			CONSTRAINT cao_canonical_github_run_id_kind CHECK (COALESCE(
				(github_run_id IS NULL AND github_run_id_kind IS NULL AND github_run_id_numeric IS NULL) OR
				(github_run_id_kind = 'string' AND github_run_id IS NOT NULL AND github_run_id_numeric IS NULL) OR
				(github_run_id_kind = 'number' AND
					(github_run_id IS NOT NULL OR github_run_id_numeric IS NOT NULL)), FALSE)),
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_id ON cao_canonical_rows
			(namespace, source_name, id) WHERE id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_run_id ON cao_canonical_rows
			(namespace, source_name, run_id) WHERE run_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_session_id ON cao_canonical_rows
			(namespace, source_name, session_id) WHERE session_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_repository_id ON cao_canonical_rows
			(namespace, source_name, repository_id) WHERE repository_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_workflow_id ON cao_canonical_rows
			(namespace, source_name, workflow_id) WHERE workflow_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_created_at ON cao_canonical_rows
			(namespace, source_name, created_at) WHERE created_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_started_at ON cao_canonical_rows
			(namespace, source_name, started_at) WHERE started_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_timestamp_at ON cao_canonical_rows
			(namespace, source_name, timestamp_at) WHERE timestamp_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_observed_at ON cao_canonical_rows
			(namespace, source_name, observed_at) WHERE observed_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_enabled ON cao_canonical_rows
			(namespace, source_name, enabled) WHERE enabled IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS cao_canonical_rows_is_pull_request ON cao_canonical_rows
			(namespace, source_name, is_pull_request) WHERE is_pull_request IS NOT NULL`,
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
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS storage_fallback_reason TEXT`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_extension JSON`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_present TEXT[] NOT NULL DEFAULT ARRAY[]::text[]`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_source_id TEXT`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_source_revision TEXT`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_source_kind TEXT`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_availability TEXT`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_row_count_null BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE cao_sources ADD COLUMN IF NOT EXISTS metadata_migrated BOOLEAN NOT NULL DEFAULT FALSE`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	var documentPayloadType string
	if err = tx.QueryRowContext(ctx, `SELECT data_type FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_source_documents'
			AND column_name = 'payload'`).Scan(&documentPayloadType); err != nil {
		return err
	}
	if documentPayloadType != "json" {
		if _, err = tx.ExecContext(ctx, `ALTER TABLE cao_source_documents
			ALTER COLUMN payload TYPE JSON USING payload::json`); err != nil {
			return err
		}
	}
	// Existing installations predate part of the producer schema. Extend the
	// canonical table atomically in the same transaction as any backfill.
	var contentsType sql.NullString
	if err = tx.QueryRowContext(ctx, `SELECT data_type FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
			AND column_name = 'contents'`).Scan(&contentsType); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	legacyContents := contentsType.Valid && contentsType.String == "json"
	if legacyContents {
		if _, err = tx.ExecContext(ctx, `ALTER TABLE cao_canonical_rows RENAME COLUMN contents TO contents_exception`); err != nil {
			return err
		}
	} else if contentsType.Valid && contentsType.String != "ARRAY" {
		return errors.New("unsupported legacy canonical contents column")
	}
	var additions []string
	for _, field := range canonicalFields {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" TEXT")
	}
	for _, field := range canonicalTimes {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" TIMESTAMPTZ",
			"ADD COLUMN IF NOT EXISTS "+field.column+"_raw TEXT")
	}
	for _, field := range canonicalNumbers {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" NUMERIC",
			"ADD COLUMN IF NOT EXISTS "+field.column+"_raw TEXT")
	}
	for _, field := range canonicalBooleans {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" BOOLEAN")
	}
	for _, field := range canonicalArrays {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" TEXT[]")
	}
	additions = append(additions, "ADD COLUMN IF NOT EXISTS contents_exception JSON")
	for _, field := range canonicalLinks {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" TEXT",
			"ADD COLUMN IF NOT EXISTS "+field.column+"_relation TEXT",
			"ADD COLUMN IF NOT EXISTS "+field.column+"_label TEXT",
			"ADD COLUMN IF NOT EXISTS "+field.column+"_present TEXT[]")
	}
	for _, field := range canonicalObjects {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" JSON")
	}
	for _, field := range canonicalFlexibleText {
		additions = append(additions, "ADD COLUMN IF NOT EXISTS "+field.column+" JSON")
	}
	additions = append(additions, "ADD COLUMN IF NOT EXISTS value_text TEXT",
		"ADD COLUMN IF NOT EXISTS value_kind TEXT",
		"ADD COLUMN IF NOT EXISTS id_kind TEXT")
	additions = append(additions, "ADD COLUMN IF NOT EXISTS run_href_kind TEXT")
	additions = append(additions, "ADD COLUMN IF NOT EXISTS provenance_source TEXT",
		"ADD COLUMN IF NOT EXISTS provenance_source_id TEXT",
		"ADD COLUMN IF NOT EXISTS provenance_observed_at TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS provenance_observed_at_raw TEXT",
		"ADD COLUMN IF NOT EXISTS provenance_source_revision TEXT",
		"ADD COLUMN IF NOT EXISTS provenance_present TEXT[] NOT NULL DEFAULT ARRAY[]::text[]",
		"ADD COLUMN IF NOT EXISTS provenance_null BOOLEAN NOT NULL DEFAULT FALSE")
	if _, err = tx.ExecContext(ctx, "ALTER TABLE cao_canonical_rows "+strings.Join(additions, ", ")); err != nil {
		return err
	}
	var legacyProvenance bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('cao_canonical_rows')
		AND attname = 'provenance' AND NOT attisdropped)`).Scan(&legacyProvenance); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `ALTER TABLE cao_canonical_rows
		ALTER COLUMN extension DROP NOT NULL`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE cao_canonical_rows SET extension = NULL
		WHERE extension::text = '{}'`); err != nil {
		return err
	}
	for _, column := range []string{
		"experiment_id", "grader_id", "eval_id", "audit_id", "value_id",
		"registry_id", "campaign_id", "slug", "target_repository_id",
	} {
		if _, err = tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS cao_canonical_rows_`+column+
			` ON cao_canonical_rows (namespace, source_name, `+column+`) WHERE `+column+` IS NOT NULL`); err != nil {
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
	if err := migrateCanonicalLinks(ctx, tx); err != nil {
		return err
	}
	if legacyContents {
		if err := migrateCanonicalContents(ctx, tx); err != nil {
			return err
		}
	}
	if legacyProvenance {
		if err := migrateLegacyCanonicalProvenance(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE cao_canonical_rows DROP COLUMN provenance`); err != nil {
			return err
		}
	}
	if err := removeGenerationColumn(ctx, tx); err != nil {
		return err
	}
	if err := backfillCanonical(ctx, tx); err != nil {
		return err
	}
	if err := migrateCanonicalMetadata(ctx, tx); err != nil {
		return err
	}
	if err := migrateCanonicalSourceKind(ctx, tx); err != nil {
		return err
	}
	if err := migrateCanonicalExtensions(ctx, tx); err != nil {
		return err
	}
	names := make([]string, 0, len(canonicalCollections))
	for name := range canonicalCollections {
		names = append(names, name)
	}
	var unmigrated string
	err = tx.QueryRowContext(ctx, `SELECT source_name FROM cao_sources
		WHERE source_name = ANY($1) AND NOT is_canonical LIMIT 1`, names).Scan(&unmigrated)
	if err == nil {
		return fmt.Errorf("unmigrated postgres canonical source %q", unmigrated)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cao_canonical_rows'::regclass
				AND conname = 'cao_canonical_contents_exclusive') THEN
				ALTER TABLE cao_canonical_rows ADD CONSTRAINT cao_canonical_contents_exclusive
					CHECK ((contents IS NULL OR contents_exception IS NULL)
						AND ((contents IS NULL AND contents_exception IS NULL) OR 'contents' = ANY(present)));
			END IF;
		END $$`); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateCanonicalContents(ctx context.Context, tx *sql.Tx) error {
	var invalid bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM cao_canonical_rows
		WHERE contents_exception IS NOT NULL AND (
			NOT 'contents' = ANY(present) OR contents IS NOT NULL
			OR json_typeof(contents_exception) NOT IN ('null', 'array', 'object')))`).Scan(&invalid); err != nil {
		return err
	}
	if invalid {
		return errors.New("inconsistent legacy canonical contents")
	}
	_, err := tx.ExecContext(ctx, `UPDATE cao_canonical_rows r SET
		contents = ARRAY(SELECT json_array_elements_text(r.contents_exception)),
		contents_exception = NULL
		WHERE json_typeof(r.contents_exception) = 'array'
		AND NOT EXISTS (SELECT 1 FROM json_array_elements(CASE
			WHEN json_typeof(r.contents_exception) = 'array' THEN r.contents_exception
			ELSE '[]'::json END) AS part
			WHERE json_typeof(part) <> 'string')`)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE cao_canonical_rows SET contents_exception = NULL
		WHERE json_typeof(contents_exception) = 'null'`)
	return err
}

// Undo the short-lived native generation column without losing older rows.
// The logical field returns to the open extension, as it was before that column.
func removeGenerationColumn(ctx context.Context, tx *sql.Tx) error {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('cao_canonical_rows')
		AND attname = 'generation' AND NOT attisdropped)`).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return nil
	}
	var duplicates bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM cao_canonical_rows r
		WHERE (r.generation IS NOT NULL AND NOT 'generation' = ANY(r.present))
			OR ('generation' = ANY(r.present)
				AND EXISTS (SELECT 1 FROM json_object_keys(r.extension) AS key WHERE key = 'generation'))
	)`).Scan(&duplicates); err != nil {
		return err
	}
	if duplicates {
		return errors.New("inconsistent native generation field in canonical row")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE cao_canonical_rows AS r SET
		extension = (SELECT json_object_agg(key, value) FROM (
			SELECT key, value FROM json_each(COALESCE(r.extension, '{}'::json))
			UNION ALL SELECT 'generation', to_json(r.generation)
		) AS fields),
		present = array_remove(r.present, 'generation')
		WHERE 'generation' = ANY(r.present)`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `ALTER TABLE cao_canonical_rows DROP COLUMN generation`)
	return err
}

func migrateCanonicalLinks(ctx context.Context, tx *sql.Tx) error {
	for _, field := range canonicalLinks {
		rich := field.column + "_json"
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute
			WHERE attrelid = to_regclass('cao_canonical_rows')
			AND attname = $1 AND NOT attisdropped)`, rich).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			continue
		}
		var invalid bool
		// All identifiers are from the static canonical link catalogue.
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM cao_canonical_rows r WHERE `+rich+` IS NOT NULL
			AND (NOT $1 = ANY(r.present) OR json_typeof(`+rich+`) IS DISTINCT FROM 'object'
				OR json_typeof(`+rich+` -> 'href') IS DISTINCT FROM 'string'
				OR EXISTS (SELECT 1 FROM json_each(`+rich+`) AS part
					WHERE part.key NOT IN ('href', 'relation', 'label')
					OR (part.key <> 'href' AND json_typeof(part.value) NOT IN ('string', 'null')))
				OR `+field.column+` IS NOT NULL)
		)`, field.key).Scan(&invalid); err != nil {
			return err
		}
		if invalid {
			return fmt.Errorf("invalid legacy canonical link %s", field.key)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE cao_canonical_rows r SET
			`+field.column+` = COALESCE(`+field.column+`, `+rich+` ->> 'href'),
			`+field.column+`_relation = `+rich+` ->> 'relation',
			`+field.column+`_label = `+rich+` ->> 'label',
			`+field.column+`_present = CASE
				WHEN `+rich+` IS NOT NULL THEN ARRAY(SELECT key FROM json_object_keys(`+rich+`) AS key ORDER BY key)
				WHEN `+field.column+` IS NOT NULL AND ($1 <> 'runLink' OR run_href_kind <> 'string')
					THEN ARRAY['href']::text[]
			END
			WHERE $1 = ANY(r.present)`, field.key); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE cao_canonical_rows DROP COLUMN `+rich); err != nil {
			return err
		}
	}
	return nil
}

func migrateCanonicalSourceKind(ctx context.Context, tx *sql.Tx) error {
	var invalid bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM cao_sources WHERE metadata_migrated
		AND metadata_extension IS NOT NULL
		AND EXISTS (SELECT 1 FROM json_object_keys(metadata_extension) AS key WHERE key = 'source-kind')
		AND ('source-kind' = ANY(metadata_present)
			OR json_typeof(metadata_extension -> 'source-kind') NOT IN ('string', 'null'))
	)`).Scan(&invalid); err != nil {
		return err
	}
	if invalid {
		return errors.New("invalid or duplicated canonical metadata source-kind")
	}
	_, err := tx.ExecContext(ctx, `UPDATE cao_sources AS s SET
		metadata_source_kind = s.metadata_extension ->> 'source-kind',
		metadata_present = array_append(s.metadata_present, 'source-kind'),
		metadata_extension = (SELECT COALESCE(json_object_agg(key, value), '{}'::json)
			FROM json_each(s.metadata_extension) WHERE key <> 'source-kind')
		WHERE s.metadata_migrated AND s.metadata_extension IS NOT NULL
		AND EXISTS (SELECT 1 FROM json_object_keys(s.metadata_extension) AS key WHERE key = 'source-kind')`)
	return err
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
	declare, _, err := postgresSQL(`DECLARE {} NO SCROLL CURSOR FOR `+selectSQL, sqlIdentifier(cursor))
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, declare); err != nil {
		return err
	}
	fetch, _, err := postgresSQL(`FETCH FORWARD 256 FROM {}`, sqlIdentifier(cursor))
	if err != nil {
		return err
	}
	batch := valueBatch{ctx: ctx, tx: tx}
	type item struct {
		namespace, name string
		ordinal         int64
		payload         []byte
	}
	for {
		rows, err := tx.QueryContext(ctx, fetch)
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
	closeCursor, _, err := postgresSQL(`CLOSE {}`, sqlIdentifier(cursor))
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, closeCursor); err != nil {
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

// StorageFallbacks reports canonical sources that could not use typed storage.
// Reasons name only field shapes or types, never record values.
func (s *Store) StorageFallbacks(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT source_name, storage_fallback_reason FROM cao_sources
		WHERE namespace = $1 AND storage_fallback_reason IS NOT NULL`, s.namespace)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := map[string]string{}
	for rows.Next() {
		var name, reason string
		if err := rows.Scan(&name, &reason); err != nil {
			return nil, err
		}
		result[name] = reason
	}
	return result, rows.Err()
}

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
			is_canonical = $2, storage_fallback_reason = NULLIF($3, '')
			WHERE namespace = $4 AND source_name = $5`, estimatedBytes, typed, "", s.namespace, name); err != nil {
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
			metadata_row_count_null = $7, metadata_migrated = TRUE
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
	var migrated, rowCountNull bool
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT s.metadata_extension::text,
		s.metadata_present, s.metadata_source_id, s.metadata_source_revision,
		s.metadata_availability, s.metadata_source_kind, s.metadata_migrated, s.metadata_row_count_null, c.count
		FROM cao_sources s JOIN cao_counts c
		ON c.namespace = s.namespace AND c.source_name = s.source_name
		WHERE s.namespace = $1 AND s.source_name = $2 AND s.is_canonical`,
		namespace, name).Scan(&extension, &present, &sourceID, &revision,
		&availability, &sourceKind, &migrated, &rowCountNull, &count); err != nil {
		return nil, err
	}
	if !migrated {
		return nil, errors.New("unmigrated postgres canonical metadata")
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

func migrateCanonicalMetadata(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `DECLARE canonical_metadata_cursor NO SCROLL CURSOR FOR
		SELECT s.namespace, s.source_name, d.payload::text, c.count
		FROM cao_sources s JOIN cao_counts c
		ON c.namespace = s.namespace AND c.source_name = s.source_name
		LEFT JOIN cao_source_documents d ON d.namespace = s.namespace
			AND d.source_name = s.source_name AND d.ordinal = -1
		WHERE s.is_canonical AND NOT s.metadata_migrated
		ORDER BY s.namespace, s.source_name`); err != nil {
		return err
	}
	defer func() { _, _ = tx.ExecContext(ctx, "CLOSE canonical_metadata_cursor") }()
	for {
		type entry struct {
			namespace, name string
			payload         sql.NullString
			count           int
		}
		entries, err := func() ([]entry, error) {
			rows, err := tx.QueryContext(ctx, "FETCH FORWARD 256 FROM canonical_metadata_cursor")
			if err != nil {
				return nil, err
			}
			defer func() { _ = rows.Close() }()
			entries := make([]entry, 0, 256)
			for rows.Next() {
				var item entry
				if err := rows.Scan(&item.namespace, &item.name, &item.payload, &item.count); err != nil {
					return nil, err
				}
				entries = append(entries, item)
			}
			return entries, rows.Err()
		}()
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		for _, item := range entries {
			if !item.payload.Valid {
				return fmt.Errorf("missing canonical metadata in %q", item.name)
			}
			var metadata any
			if err := decodeJSON([]byte(item.payload.String), &metadata); err != nil {
				return err
			}
			if err := writeCanonicalMetadata(ctx, tx, item.namespace, item.name, metadata, item.count); err != nil {
				return fmt.Errorf("migrate canonical metadata in %q: %w", item.name, err)
			}
			restored, err := readCanonicalMetadata(ctx, tx, item.namespace, item.name)
			if err != nil {
				return err
			}
			if original, ok := metadata.(map[string]any); ok {
				if !reflect.DeepEqual(restored, model.Metadata(original)) {
					return fmt.Errorf("canonical metadata migration changed source %q", item.name)
				}
			} else if metadata != nil || restored != nil {
				return fmt.Errorf("canonical metadata migration changed source %q", item.name)
			}
		}
	}
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
			return model.Source{}, model.Metrics{}, errors.New("unmigrated postgres canonical source")
		}
	}
	// Current schemaless sources use documents alone; EAV is read only for
	// pre-document schemaless revisions.
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
