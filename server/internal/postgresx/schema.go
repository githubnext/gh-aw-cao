package postgresx

import (
	"context"
	"database/sql"
	"reflect"
	"sort"
	"strings"
)

type storageColumn struct {
	name, kind, attributes string
}

type storageTable struct {
	name        string
	columns     []storageColumn
	constraints []string
}

func storageTables() []storageTable {
	canonical := []storageColumn{
		{"namespace", "text", "NOT NULL"}, {"source_name", "text", "NOT NULL"},
		{"ordinal", "bigint", "NOT NULL"}, {"present", "text[]", "NOT NULL"},
		{"extension", "json", ""},
	}
	for _, field := range canonicalFields {
		canonical = append(canonical, storageColumn{field.column, "text", ""})
	}
	for _, group := range [][]struct{ key, column string }{canonicalTimes, canonicalNumbers} {
		for _, field := range group {
			kind := "numeric"
			if isCanonicalTime(field.key) {
				kind = "timestamptz"
			}
			canonical = append(canonical, storageColumn{field.column, kind, ""},
				storageColumn{field.column + "_raw", "text", ""})
		}
	}
	for _, field := range canonicalBooleans {
		canonical = append(canonical, storageColumn{field.column, "boolean", ""})
	}
	for _, field := range canonicalIdentifiers {
		canonical = append(canonical, storageColumn{field.column, "text", ""},
			storageColumn{field.column + "_kind", "text", ""},
			storageColumn{field.column + "_numeric", "numeric", ""})
	}
	for _, field := range canonicalLinks {
		canonical = append(canonical, storageColumn{field.column, "text", ""},
			storageColumn{field.column + "_relation", "text", ""},
			storageColumn{field.column + "_label", "text", ""},
			storageColumn{field.column + "_present", "text[]", ""})
	}
	for _, field := range canonicalArrays {
		canonical = append(canonical, storageColumn{field.column, "text[]", ""})
	}
	for _, field := range canonicalObjects {
		kind := "json"
		if native, ok := nativeNestedFields[field.key]; ok {
			kind = native.sqlType()
		}
		canonical = append(canonical, storageColumn{field.column, kind, ""})
	}
	for _, field := range canonicalFlexibleText {
		canonical = append(canonical, storageColumn{field.column, "json", ""})
	}
	canonical = append(canonical,
		storageColumn{"value_text", "text", ""}, storageColumn{"value_kind", "text", ""},
		storageColumn{"id_kind", "text", ""}, storageColumn{"run_href_kind", "text", ""},
		storageColumn{"provenance_source", "text", ""}, storageColumn{"provenance_source_id", "text", ""},
		storageColumn{"provenance_observed_at", "timestamptz", ""},
		storageColumn{"provenance_observed_at_raw", "text", ""},
		storageColumn{"provenance_source_revision", "text", ""},
		storageColumn{"provenance_present", "text[]", "NOT NULL DEFAULT ARRAY[]::text[]"},
		storageColumn{"provenance_null", "boolean", "NOT NULL DEFAULT FALSE"})
	const sourceFK = "FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE"
	const stateFK = "FOREIGN KEY (namespace) REFERENCES cao_state(namespace) ON DELETE CASCADE"
	canonicalConstraints := make([]string, 0, 3+len(canonicalIdentifiers))
	canonicalConstraints = append(canonicalConstraints,
		"PRIMARY KEY (namespace, source_name, ordinal)", sourceFK,
		`CONSTRAINT cao_canonical_contents_present CHECK (contents IS NULL OR (
			'contents' = ANY(present) AND COALESCE(array_ndims(contents), 1) = 1
			AND array_position(contents, NULL) IS NULL))`)
	for _, field := range canonicalIdentifiers {
		column := field.column
		canonicalConstraints = append(canonicalConstraints, "CONSTRAINT cao_canonical_"+column+`_kind CHECK (COALESCE(
			(`+column+` IS NULL AND `+column+`_kind IS NULL AND `+column+`_numeric IS NULL) OR
			(`+column+`_kind = 'string' AND `+column+` IS NOT NULL AND `+column+`_numeric IS NULL) OR
			(`+column+`_kind = 'number' AND (`+column+` IS NOT NULL OR `+column+`_numeric IS NOT NULL)), FALSE))`)
	}
	return []storageTable{
		{"cao_sources", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"source_name", "text", "NOT NULL"},
			{"estimated_bytes", "bigint", ""}, {"is_canonical", "boolean", "NOT NULL DEFAULT FALSE"},
			{"metadata_extension", "json", ""},
			{"metadata_present", "text[]", "NOT NULL DEFAULT ARRAY[]::text[]"},
			{"metadata_source_id", "text", ""}, {"metadata_source_revision", "text", ""},
			{"metadata_source_kind", "text", ""}, {"metadata_availability", "text", ""},
			{"metadata_row_count_null", "boolean", "NOT NULL DEFAULT FALSE"},
		}, []string{"PRIMARY KEY (namespace, source_name)"}},
		{"cao_state", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"revision", "bigint", "NOT NULL"},
			{"data_revision", "text", "NOT NULL"}, {"evaluated_at", "timestamptz", "NOT NULL"},
			{"schema_version", "bigint", "NOT NULL DEFAULT 0"},
			{"diagnostic_counts_present", "boolean", "NOT NULL DEFAULT FALSE"},
			{"relationship_errors_present", "boolean", "NOT NULL DEFAULT FALSE"},
			{"duplicate_ids_present", "boolean", "NOT NULL DEFAULT FALSE"},
		}, []string{"PRIMARY KEY (namespace)"}},
		{"cao_canonical_rows", canonical, canonicalConstraints},
		{"cao_source_documents", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"source_name", "text", "NOT NULL"},
			{"ordinal", "bigint", "NOT NULL"}, {"payload", "json", "NOT NULL"},
			{"id", "text", ""}, {"run_id", "text", ""}, {"session_id", "text", ""},
		}, []string{"PRIMARY KEY (namespace, source_name, ordinal)", sourceFK}},
		{"cao_counts", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"source_name", "text", "NOT NULL"},
			{"count", "bigint", "NOT NULL"},
		}, []string{"PRIMARY KEY (namespace, source_name)", stateFK}},
		{"cao_diagnostic_counts", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"name", "text", "NOT NULL"}, {"count", "bigint", "NOT NULL"},
		}, []string{"PRIMARY KEY (namespace, name)", stateFK}},
		{"cao_relationship_errors", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"ordinal", "bigint", "NOT NULL"},
			{"message", "text", "NOT NULL"},
		}, []string{"PRIMARY KEY (namespace, ordinal)", stateFK}},
		{"cao_duplicate_ids", []storageColumn{
			{"namespace", "text", "NOT NULL"}, {"name", "text", "NOT NULL"},
			{"ordinal", "bigint", "NOT NULL"}, {"record_id", "text", "NOT NULL"},
		}, []string{"PRIMARY KEY (namespace, name, ordinal)", stateFK}},
	}
}

// Initialization creates the current schema or verifies it, never upgrades data.
func initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(712083241, 17483)`); err != nil {
		return err
	}
	tables := storageTables()
	expected := make([]string, 0, len(tables))
	for _, table := range tables {
		expected = append(expected, table.name)
	}
	sort.Strings(expected)
	reserved := append(append([]string{}, expected...), "cao_source_rows", "cao_values")
	var existing []string
	if err := tx.QueryRowContext(ctx, `SELECT array_agg(relname::text ORDER BY relname)
		FROM pg_class WHERE relnamespace = current_schema()::regnamespace
		AND relname = ANY($1)`, reserved).Scan(&existing); err != nil {
		return err
	}
	if len(existing) != 0 && !reflect.DeepEqual(existing, expected) {
		return ErrFreshDatabaseRequired
	}
	if err := initializeNestedTypes(ctx, tx); err != nil {
		return err
	}
	if len(existing) != 0 {
		for _, table := range tables {
			if err := verifyStorageTable(ctx, tx, table); err != nil {
				return err
			}
		}
		return tx.Commit()
	}
	for _, table := range tables {
		columns := make([]string, 0, len(table.columns)+len(table.constraints))
		for _, column := range table.columns {
			columns = append(columns, column.name+" "+column.kind+" "+column.attributes)
		}
		columns = append(columns, table.constraints...)
		// #nosec G202 -- all identifiers and definitions are from the static storage catalogue.
		if _, err := tx.ExecContext(ctx, "CREATE TABLE "+table.name+" ("+strings.Join(columns, ",")+")"); err != nil {
			return err
		}
	}
	for _, index := range []struct {
		table   string
		columns []string
	}{
		{"cao_canonical_rows", []string{"id", "run_id", "session_id", "repository_id", "workflow_id",
			"created_at", "started_at", "timestamp_at", "observed_at", "enabled", "is_pull_request",
			"experiment_id", "grader_id", "eval_id", "audit_id", "value_id", "registry_id", "campaign_id",
			"slug", "target_repository_id"}},
		{"cao_source_documents", []string{"id", "run_id", "session_id"}},
	} {
		for _, column := range index.columns {
			// #nosec G202 -- table and column names are schema-owned constants.
			if _, err := tx.ExecContext(ctx, "CREATE INDEX "+index.table+"_"+column+" ON "+index.table+
				" (namespace, source_name, "+column+") WHERE "+column+" IS NOT NULL"); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func verifyStorageTable(ctx context.Context, tx *sql.Tx, table storageTable) error {
	names, kinds := make([]string, 0, len(table.columns)), make([]string, 0, len(table.columns))
	required := make([]bool, 0, len(table.columns))
	for _, column := range table.columns {
		names, kinds = append(names, column.name), append(kinds, column.kind)
		required = append(required, strings.Contains(column.attributes, "NOT NULL"))
	}
	var valid bool
	if err := tx.QueryRowContext(ctx, `SELECT NOT EXISTS(
		SELECT 1 FROM (
			SELECT a.attname::text AS name, a.atttypid AS kind, a.attnotnull AS required, a.attnum AS position
			FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
			WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1
			AND c.relkind IN ('r', 'c') AND a.attnum > 0 AND NOT a.attisdropped
		) actual FULL JOIN unnest($2::text[], $3::text[], $4::boolean[])
			WITH ORDINALITY expected(name, kind, required, position)
		ON actual.name = expected.name
		WHERE actual.name IS NULL OR expected.name IS NULL
			OR actual.kind IS DISTINCT FROM to_regtype(expected.kind)::oid
			OR actual.required IS DISTINCT FROM expected.required
			OR actual.position IS DISTINCT FROM expected.position)`,
		table.name, names, kinds, required).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrFreshDatabaseRequired
	}
	return nil
}
