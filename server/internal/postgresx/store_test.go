package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestDecodeJSONPreservesNumbers(t *testing.T) {
	var row model.Row
	if err := decodeJSON([]byte(`{"large":9007199254740993,"fraction":1.25,"nested":[2]}`), &row); err != nil {
		t.Fatal(err)
	}
	if row["large"] != json.Number("9007199254740993") || row["fraction"] != json.Number("1.25") {
		t.Fatalf("numbers were rounded or changed: %#v", row)
	}
	if nested := row["nested"].([]any); nested[0] != json.Number("2") {
		t.Fatalf("nested number was changed: %#v", nested)
	}
}

func TestNamespaceRequired(t *testing.T) {
	if _, err := NewWithNamespace(t.Context(), "", ""); err == nil {
		t.Fatal("empty namespace must fail before attempting a connection")
	}
	if _, err := New(t.Context(), "", ""); err == nil {
		t.Fatal("empty explicit namespace must fail before attempting a connection")
	}
	if _, err := New(t.Context(), "", "one", "two"); err == nil {
		t.Fatal("multiple namespaces must fail before attempting a connection")
	}
}

func TestConnectionTransport(t *testing.T) {
	for _, tc := range []struct {
		name, dsn string
		allowed   bool
	}{
		{"remote default prefer", "postgres://db.example.com/data", false},
		{"remote prefer fallback", "postgres://db.example.com/data?sslmode=prefer", false},
		{"remote allow fallback", "postgres://db.example.com/data?sslmode=allow", false},
		{"remote disable", "postgres://db.example.com/data?sslmode=disable", false},
		{"remote require", "postgres://db.example.com/data?sslmode=require", true},
		{"remote verify full", "postgres://db.example.com/data?sslmode=verify-full", true},
		{"keyword remote disable", "host=db.example.com user=user sslmode=disable", false},
		{"keyword remote require", "host=db.example.com user=user sslmode=require", true},
		{"loopback ipv4", "postgres://127.0.0.1:5432/data?sslmode=disable", true},
		{"loopback ipv6", "postgres://[::1]:5432/data?sslmode=disable", true},
		{"localhost", "postgres://localhost:5432/data?sslmode=disable", true},
		{"remote fallback from loopback", "host=127.0.0.1,db.example.com sslmode=disable", false},
		{"unix socket", "host=/run/postgresql sslmode=disable", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config, err := pgx.ParseConfig(tc.dsn)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateTransport(config); (err == nil) != tc.allowed {
				t.Fatalf("allowed=%t, transport validation error: %v", tc.allowed, err)
			}
		})
	}
}

func TestRejectsInsecureDSNWithoutLeakingCredentials(t *testing.T) {
	secret := "visible-in-error"
	dsn := "postgres://user:" + secret + "@db.example.com/data?sslmode=prefer"
	_, err := New(t.Context(), dsn)
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), dsn) {
		t.Fatalf("insecure DSN not safely rejected: %v", err)
	}
	_, err = New(t.Context(), "postgres://user:"+secret+"@[invalid")
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("malformed DSN not safely rejected: %v", err)
	}
}

func TestStoreIntegration(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTransport(config); err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_postgresx_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	initial, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Ready || initial.Revision != 0 || len(initial.Counts) != 0 {
		t.Fatalf("fresh store state: %+v", initial)
	}
	if _, _, err := store.LoadSource(ctx, "missing", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("missing source error: %v", err)
	}
	evaluatedAt := time.Now().UTC().Truncate(time.Microsecond)
	var deep any = json.Number("12345678901234567890.12345678901234567890")
	for i := 0; i < 64; i++ {
		deep = map[string]any{"level": []any{deep}}
	}
	bulkRows := make([]model.Row, 1100)
	bulkRows[0] = model.Row{}
	for i := 1; i < len(bulkRows); i++ {
		number := json.Number(strconv.Itoa(i))
		bulkRows[i] = model.Row{"id": number, "nested": []any{map[string]any{"values": []any{number, nil}}}}
	}
	sources := map[string]model.Source{
		"$runs": {
			Source: "$runs",
			Rows: []model.Row{
				{"id": "raw-1", "nested": map[string]any{
					"large":       json.Number("9007199254740993"),
					"array":       []any{map[string]any{"deep": []any{json.Number("1.2345678901234567890123456789"), nil, true}}, []any{}, map[string]any{}},
					"unusual/key": json.Number("1e1000000"),
				}},
			},
			Metadata: model.Metadata{"kind": "canonical"},
		},
		"repositories": {
			Source: "repositories",
			Rows: []model.Row{
				{"id": "a", "count": json.Number("9007199254740993")},
				{"id": "b", "count": json.Number("2")},
			},
			Metadata: model.Metadata{"origin": "inventory", "version": json.Number("3"), "nested": []any{map[string]any{"": []any{false, nil, "value"}}}},
		},
		"empty": {Source: "empty", Rows: []model.Row{}, Metadata: model.Metadata{"origin": "inventory"}},
		"deep":  {Source: "deep", Rows: []model.Row{{"nested": deep}}, Metadata: model.Metadata{"nested": deep}},
		"bulk":  {Source: "bulk", Rows: bulkRows},
	}
	diagnostics := model.Diagnostics{SchemaVersion: model.SchemaVersion, Counts: map[string]int{"repositories": 2}, RelationshipErrors: []string{"test diagnostic"}, DuplicateRecordIDs: map[string][]string{"present-empty": {}, "duplicates": {"a", "b"}}}
	revision, err := store.Replace(ctx, sources, diagnostics, "test-revision", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if revision != initial.Revision+1 {
		t.Fatalf("revision = %d, want %d", revision, initial.Revision+1)
	}
	state, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Ready || state.Revision != revision || state.DataRevision != "test-revision" ||
		!state.EvaluatedAt.Equal(evaluatedAt) ||
		!reflect.DeepEqual(state.Counts, map[string]int{"$runs": 1, "repositories": 2, "empty": 0, "deep": 1, "bulk": 1100}) {
		t.Fatalf("unexpected state: %+v", state)
	}
	tenant, err := NewConfig(ctx, config, "other-tenant")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tenant.Close() }()
	tenantState, err := tenant.State(ctx)
	if err != nil || tenantState.Ready {
		t.Fatalf("other namespace should be unready: %+v, %v", tenantState, err)
	}
	if _, _, err := tenant.LoadSource(ctx, "$runs", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("other namespace leaked raw source: %v", err)
	}
	if _, err := tenant.Replace(ctx, map[string]model.Source{"$runs": {
		Source: "$runs", Rows: []model.Row{{"id": "other"}}, Metadata: model.Metadata{},
	}}, model.Diagnostics{}, "other", evaluatedAt); err != nil {
		t.Fatal(err)
	}
	if other, _, err := tenant.LoadSource(ctx, "$runs", nil); err != nil || other.Rows[0]["id"] != "other" {
		t.Fatalf("other namespace read: %+v, %v", other, err)
	}
	raw, _, err := store.LoadSource(ctx, "$runs", nil)
	if err != nil || !reflect.DeepEqual(raw.Rows, sources["$runs"].Rows) {
		t.Fatalf("raw canonical source: %+v, %v", raw, err)
	}
	deepSource, _, err := store.LoadSource(ctx, "deep", nil)
	if err != nil || !reflect.DeepEqual(deepSource.Rows, sources["deep"].Rows) ||
		!reflect.DeepEqual(deepSource.Metadata, sources["deep"].Metadata) {
		t.Fatalf("deeply nested source: %+v, %v", deepSource, err)
	}
	bulk, bulkMetrics, err := store.LoadSource(ctx, "bulk", nil)
	if err != nil || bulkMetrics.OutputRows != len(bulkRows) || bulk.Metadata != nil ||
		!reflect.DeepEqual(bulk.Rows, bulkRows) {
		t.Fatalf("batched rows or nil metadata were not preserved: rows=%d metrics=%+v metadata=%#v err=%v",
			len(bulk.Rows), bulkMetrics, bulk.Metadata, err)
	}
	assertNativeSchema(t, ctx, store.db)
	var exactNumber, textFallback bool
	if err := store.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM cao_values
		WHERE namespace = $1 AND kind = 'number' AND numeric_value = $2::numeric)`,
		"default", "9007199254740993").Scan(&exactNumber); err != nil || !exactNumber {
		t.Fatalf("large integer missing native numeric representation: %v, %v", exactNumber, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM cao_values
		WHERE namespace = $1 AND kind = 'number' AND text_value = $2 AND numeric_value IS NULL)`,
		"default", "1e1000000").Scan(&textFallback); err != nil || !textFallback {
		t.Fatalf("out-of-range number lost its lexeme: %v, %v", textFallback, err)
	}
	loaded, metrics, err := store.LoadSource(ctx, "repositories", &query.Definition{From: "repositories", Limit: intPtr(1)})
	if err != nil {
		t.Fatal(err)
	}

	if metrics.OutputRows != 2 || !reflect.DeepEqual(loaded.Rows, sources["repositories"].Rows) ||
		!reflect.DeepEqual(loaded.Metadata, sources["repositories"].Metadata) {
		t.Fatalf("unexpected source or metrics: %+v %+v", loaded, metrics)
	}
	definitions := []query.Definition{{
		Name: "selected", From: "repositories",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "b"}}},
	}}
	results, _, err := query.New(sourceLoader{store: store, ctx: ctx}).Execute(definitions, []string{"selected"})
	if err != nil || len(results["selected"].Rows) != 1 || results["selected"].Rows[0]["id"] != "b" {
		t.Fatalf("Go query result: %+v, %v", results, err)
	}
	rawResults, _, err := query.New(sourceLoader{store: store, ctx: ctx}).Execute(
		[]query.Definition{{Name: "raw", From: "$runs"}}, []string{"raw"})
	if err != nil || !reflect.DeepEqual(rawResults["raw"].Rows, raw.Rows) {
		t.Fatalf("raw query result: %+v, %v", rawResults, err)
	}
	err = store.WithReadTransaction(ctx, func(reader SourceReader) error {
		before, err := reader.State(ctx)
		if err != nil {
			return err
		}
		if _, err := store.Replace(ctx, map[string]model.Source{"$runs": {
			Source: "$runs", Rows: []model.Row{{"id": "new"}}, Metadata: model.Metadata{},
		}}, model.Diagnostics{}, "new", evaluatedAt); err != nil {
			return err
		}
		stillOld, _, err := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(
			[]query.Definition{{Name: "raw", From: "$runs"}}, []string{"raw"})
		if err != nil {
			return err
		}
		again, err := reader.State(ctx)
		if err != nil {
			return err
		}
		if before.Revision != again.Revision || !reflect.DeepEqual(stillOld["raw"].Rows, raw.Rows) {
			t.Fatalf("query read mixed revisions: before=%+v after=%+v rows=%+v", before, again, stillOld)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if latest, err := store.State(ctx); err != nil || latest.Revision != revision+1 {
		t.Fatalf("replacement did not commit independently: %+v, %v", latest, err)
	}
	// Restore the original data so the remaining rollback and replacement
	// assertions operate against their initial sources.
	revision, err = store.Replace(ctx, sources, diagnostics, "test-revision", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	state, err = store.State(ctx)
	if err != nil || state.Revision != revision {
		t.Fatalf("restored state: %+v, %v", state, err)
	}
	empty, _, err := store.LoadSource(ctx, "empty", nil)
	if err != nil || len(empty.Rows) != 0 {
		t.Fatalf("empty source: %+v, %v", empty, err)
	}
	gotDiagnostics, err := store.Diagnostics(ctx)
	if err != nil || !reflect.DeepEqual(gotDiagnostics, diagnostics) {
		t.Fatalf("diagnostics: %+v, %v", gotDiagnostics, err)
	}

	_, err = store.Replace(ctx, map[string]model.Source{
		"bad": {Source: "bad", Rows: []model.Row{{"invalid": make(chan int)}}},
	}, diagnostics, "bad", evaluatedAt)
	if err == nil {
		t.Fatal("expected failed replacement")
	}
	afterFailure, err := store.State(ctx)
	if err != nil || !reflect.DeepEqual(afterFailure, state) {
		t.Fatalf("failed replacement changed state: %+v, %v", afterFailure, err)
	}
	if _, _, err := store.LoadSource(ctx, "repositories", nil); err != nil {
		t.Fatalf("failed replacement lost source: %v", err)
	}
	revision, err = store.Replace(ctx, map[string]model.Source{"empty": sources["empty"]}, diagnostics, "next", evaluatedAt)
	if err != nil || revision != state.Revision+1 {
		t.Fatalf("second replacement: %d, %v", revision, err)
	}
	if _, _, err := store.LoadSource(ctx, "repositories", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("removed source error: %v", err)
	}
}

func intPtr(n int) *int { return &n }

type sourceLoader struct {
	store *Store
	ctx   context.Context
}

type readerLoader struct {
	reader SourceReader
	ctx    context.Context
}

func (l readerLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return l.reader.LoadSource(l.ctx, name, definition)
}

func (l sourceLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return l.store.LoadSource(l.ctx, name, definition)
}

func assertNativeSchema(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	var count int
	err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name IN
		('cao_sources', 'cao_source_rows', 'cao_state', 'cao_values', 'cao_counts',
		 'cao_diagnostic_counts', 'cao_relationship_errors', 'cao_duplicate_ids')
		AND (data_type IN ('json', 'jsonb') OR column_name IN ('metadata', 'payload', 'diagnostics'))`).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("legacy JSON columns remain: count=%d err=%v", count, err)
	}
	var nativeNumeric bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_values'
		AND column_name = 'numeric_value' AND data_type = 'numeric')`).Scan(&nativeNumeric)
	if err != nil || !nativeNumeric {
		t.Fatalf("missing native numeric column: %v, %v", nativeNumeric, err)
	}
}

func TestLegacyMigrationFailureRollsBack(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTransport(config); err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_postgresx_rollback_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	for _, statement := range []string{
		`CREATE TABLE cao_sources (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
				metadata JSONB NOT NULL, PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE cao_source_rows (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
				ordinal BIGINT NOT NULL, payload JSONB NOT NULL,
				PRIMARY KEY (namespace, source_name, ordinal),
				FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE cao_state (namespace TEXT PRIMARY KEY, revision BIGINT NOT NULL,
				data_revision TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
				counts JSONB NOT NULL, diagnostics JSONB NOT NULL)`,
		`INSERT INTO cao_sources VALUES ('tenant', 'raw', '{"keep":true}'::jsonb)`,
		`INSERT INTO cao_state VALUES ('tenant', 1, 'old', now(), '{"raw":0}'::jsonb,
				'{"schemaVersion":"invalid"}'::jsonb)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if store, err := NewConfig(ctx, config, "tenant"); err == nil {
		_ = store.Close()
		t.Fatal("invalid legacy diagnostics must abort migration")
	}
	var preserved bool
	if err := legacy.QueryRowContext(ctx, `SELECT metadata->>'keep' = 'true' FROM cao_sources
			WHERE namespace = 'tenant' AND source_name = 'raw'`).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("failed migration changed legacy data: %v, %v", preserved, err)
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_state SET diagnostics = '{"schemaVersion":14}'::jsonb`); err != nil {
		t.Fatal(err)
	}
	store, err := NewConfig(ctx, config, "tenant")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	assertNativeSchema(t, ctx, store.db)
	source, _, err := store.LoadSource(ctx, "raw", nil)
	if err != nil || source.Metadata["keep"] != true {
		t.Fatalf("retry lost legacy metadata: %+v, %v", source, err)
	}
}
func TestLegacyJSONBMigrationAllTenants(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTransport(config); err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_postgresx_migration_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	for _, statement := range []string{
		`CREATE TABLE cao_sources (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
			metadata JSONB NOT NULL, PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE cao_source_rows (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
			ordinal BIGINT NOT NULL, payload JSONB NOT NULL,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE cao_state (namespace TEXT PRIMARY KEY, revision BIGINT NOT NULL,
			data_revision TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
			counts JSONB NOT NULL, diagnostics JSONB NOT NULL)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, tenant := range []string{"first", "second"} {
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_sources VALUES ($1, 'raw', $2::jsonb)`,
			tenant, `{"origin":{"nested":[9007199254740993,null,{"a":true}]}}`); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_sources VALUES
			($1, 'empty-meta', '{}'::jsonb), ($1, 'null-meta', 'null'::jsonb)`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows VALUES ($1, 'raw', 0, $2::jsonb)`,
			tenant, `{"owner":"`+tenant+`","values":[{"number":1.234567890123456789},[],null]}`); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows VALUES ($1, 'raw', 1, '{}'::jsonb)`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows
			SELECT $1, 'raw', ordinal, '{}'::jsonb FROM generate_series(2, 269) AS ordinal`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_state VALUES
			($1, 7, 'legacy', '2025-01-01'::timestamptz, $2::jsonb, $3::jsonb)`,
			tenant, `{"raw":270,"empty-meta":0,"null-meta":0}`, `{"schemaVersion":14,"counts":{"raw":1},"relationshipErrors":["warning"],"duplicateRecordIds":{"raw":["a"],"empty":[]}}`); err != nil {
			t.Fatal(err)
		}
	}
	type opened struct {
		name  string
		store *Store
		err   error
	}
	start := make(chan struct{})
	results := make(chan opened, 2)
	for _, tenant := range []string{"first", "second"} {
		go func(tenant string) {
			<-start
			store, err := NewConfig(ctx, config, tenant)
			results <- opened{tenant, store, err}
		}(tenant)
	}
	close(start)
	openedStores := map[string]*Store{}
	for i := 0; i < 2; i++ {
		result := <-results
		if result.store != nil {
			defer func() { _ = result.store.Close() }()
		}
		if result.err != nil {
			t.Fatalf("concurrent %s startup: %v", result.name, result.err)
		}
		openedStores[result.name] = result.store
	}
	first, second := openedStores["first"], openedStores["second"]
	assertNativeSchema(t, ctx, first.db)
	for _, tc := range []struct {
		name  string
		store *Store
	}{{"first", first}, {"second", second}} {
		state, err := tc.store.State(ctx)
		if err != nil || !state.Ready || state.Revision != 7 || state.Counts["raw"] != 270 || state.DataRevision != "legacy" {
			t.Fatalf("%s migrated state: %+v, %v", tc.name, state, err)
		}
		source, _, err := tc.store.LoadSource(ctx, "raw", nil)
		if err != nil {
			t.Fatal(err)
		}
		if source.Rows[0]["owner"] != tc.name ||
			source.Rows[0]["values"].([]any)[0].(map[string]any)["number"] != json.Number("1.234567890123456789") ||
			source.Metadata["origin"].(map[string]any)["nested"].([]any)[0] != json.Number("9007199254740993") ||
			len(source.Rows) != 270 || len(source.Rows[1]) != 0 || len(source.Rows[269]) != 0 {
			t.Fatalf("%s migrated source: %+v", tc.name, source)
		}
		for _, shape := range []struct {
			name     string
			metadata model.Metadata
		}{{"empty-meta", model.Metadata{}}, {"null-meta", nil}} {
			loaded, _, err := tc.store.LoadSource(ctx, shape.name, nil)
			if err != nil || !reflect.DeepEqual(loaded.Metadata, shape.metadata) || len(loaded.Rows) != 0 {
				t.Fatalf("%s metadata shape %s: %+v, %v", tc.name, shape.name, loaded, err)
			}
		}
		diag, err := tc.store.Diagnostics(ctx)
		if err != nil || !reflect.DeepEqual(diag, model.Diagnostics{
			SchemaVersion: 14, Counts: map[string]int{"raw": 1},
			RelationshipErrors: []string{"warning"},
			DuplicateRecordIDs: map[string][]string{"raw": {"a"}, "empty": {}},
		}) {
			t.Fatalf("%s migrated diagnostics: %+v, %v", tc.name, diag, err)
		}
	}
	if _, err := first.Replace(ctx, map[string]model.Source{"raw": {
		Rows: []model.Row{{"owner": "updated"}}, Metadata: model.Metadata{},
	}}, model.Diagnostics{}, "updated", time.Now()); err != nil {
		t.Fatal(err)
	}
	source, _, err := second.LoadSource(ctx, "raw", nil)
	if err != nil || source.Rows[0]["owner"] != "second" {
		t.Fatalf("migration mixed tenants: %+v, %v", source, err)
	}
}
