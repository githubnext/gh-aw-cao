package postgresx

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func schemaFixture(t *testing.T) (context.Context, *pgx.ConnConfig, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	t.Cleanup(func() { _ = admin.Close() })
	schema := fmt.Sprintf("cao_current_schema_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") })
	config.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*config.Copy())
	t.Cleanup(func() { _ = db.Close() })
	return ctx, config, db
}

func TestFreshSchemaConcurrentInitialization(t *testing.T) {
	ctx, config, db := schemaFixture(t)
	if _, err := db.ExecContext(ctx, `CREATE TABLE unrelated (value TEXT);
		INSERT INTO unrelated VALUES ('keep')`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		store *Store
		err   error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			store, err := NewConfig(ctx, config.Copy())
			results <- result{store, err}
		}()
	}
	var stores []*Store
	for range 2 {
		got := <-results
		if got.store != nil {
			stores = append(stores, got.store)
			t.Cleanup(func() { _ = got.store.Close() })
		}
		if got.err != nil {
			t.Errorf("concurrent initialization: %v", got.err)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	assertNativeSchema(t, ctx, db)
	var tables int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_class
		WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r'
		AND relname LIKE 'cao_%'`).Scan(&tables); err != nil || tables != 8 {
		t.Fatalf("fresh store must have only eight active tables: count=%d err=%v", tables, err)
	}
	sources := map[string]model.Source{
		"$jobs": {Source: "$jobs", Rows: []model.Row{{"id": "job", "runId": "run", "status": "completed"}},
			Metadata: model.Metadata{"source-id": "$jobs"}},
		"inventory": {Source: "inventory", Rows: []model.Row{{"arbitrary": []any{true, nil, "value"}}}},
	}
	if _, err := stores[0].Replace(ctx, sources, model.Diagnostics{}, "current", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	before, err := stores[0].State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewConfig(ctx, config.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	after, err := reopened.State(ctx)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("initialization changed state: before=%+v after=%+v err=%v", before, after, err)
	}
	for name, expected := range sources {
		got, _, err := reopened.LoadSource(ctx, name, nil)
		if err != nil || !reflect.DeepEqual(expected.Rows, got.Rows) || !reflect.DeepEqual(expected.Metadata, got.Metadata) {
			t.Fatalf("restart changed %s: got=%+v err=%v", name, got, err)
		}
	}
	var unrelated string
	if err := db.QueryRowContext(ctx, `SELECT value FROM unrelated`).Scan(&unrelated); err != nil || unrelated != "keep" {
		t.Fatalf("initialization modified unrelated data: %q %v", unrelated, err)
	}
}

func TestOldSchemaRejectedWithoutModification(t *testing.T) {
	for name, setup := range map[string]string{
		"EAV":             `CREATE TABLE cao_values (payload JSON); INSERT INTO cao_values VALUES ('{"keep":true}')`,
		"row payload":     `CREATE TABLE cao_source_rows (payload JSONB); INSERT INTO cao_source_rows VALUES ('{"keep":true}')`,
		"source metadata": `CREATE TABLE cao_sources (payload JSON); INSERT INTO cao_sources VALUES ('{"keep":true}')`,
	} {
		t.Run(name, func(t *testing.T) {
			ctx, config, db := schemaFixture(t)
			if _, err := db.ExecContext(ctx, setup); err != nil {
				t.Fatal(err)
			}
			if store, err := NewConfig(ctx, config); err == nil {
				_ = store.Close()
				t.Fatal("old schema was accepted")
			} else if !errors.Is(err, ErrFreshDatabaseRequired) {
				t.Fatalf("old schema lacks actionable error: %v", err)
			}
			var tables int
			if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_class
				WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r'`).Scan(&tables); err != nil || tables != 1 {
				t.Fatalf("rejection changed old schema: tables=%d err=%v", tables, err)
			}
			table := map[string]string{"EAV": "cao_values", "row payload": "cao_source_rows", "source metadata": "cao_sources"}[name]
			var retained string
			// #nosec G202 -- table comes from the fixed test-case catalogue above.
			if err := db.QueryRowContext(ctx, "SELECT payload::text FROM "+table).Scan(&retained); err != nil ||
				(retained != `{"keep":true}` && retained != `{"keep": true}`) {
				t.Fatalf("old row was changed: %s %v", retained, err)
			}
		})
	}
}

func TestIncompatibleCurrentSchemaRejected(t *testing.T) {
	for name, alter := range map[string]string{
		"bookkeeping": `ALTER TABLE cao_sources ADD COLUMN metadata_migrated BOOLEAN`,
		"JSON paths": `ALTER TABLE cao_canonical_rows DROP CONSTRAINT cao_canonical_contents_present;
			ALTER TABLE cao_canonical_rows ALTER COLUMN contents TYPE JSON USING NULL::json`,
		"JSON nested":   `ALTER TABLE cao_canonical_rows ALTER COLUMN workers TYPE JSON USING NULL::json`,
		"legacy table":  `CREATE TABLE cao_values (payload JSON)`,
		"missing table": `DROP TABLE cao_counts`,
	} {
		t.Run(name, func(t *testing.T) {
			ctx, config, db := schemaFixture(t)
			store, err := NewConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			sources := map[string]model.Source{"inventory": {Source: "inventory", Rows: []model.Row{{"keep": true}}}}
			if _, err := store.Replace(ctx, sources, model.Diagnostics{}, "keep", time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, alter); err != nil {
				t.Fatal(err)
			}
			if reopened, err := NewConfig(ctx, config.Copy()); err == nil {
				_ = reopened.Close()
				t.Fatal("incompatible schema was accepted")
			} else if !errors.Is(err, ErrFreshDatabaseRequired) {
				t.Fatalf("incompatible schema lacks actionable error: %v", err)
			}
			var retained string
			if err := db.QueryRowContext(ctx, `SELECT payload::text FROM cao_source_documents WHERE ordinal = 0`).
				Scan(&retained); err != nil || retained != `{"keep":true}` {
				t.Fatalf("rejection changed committed row: %s %v", retained, err)
			}
		})
	}
}

func TestIncompatibleCompositeRejected(t *testing.T) {
	ctx, config, db := schemaFixture(t)
	if _, err := db.ExecContext(ctx, `CREATE TYPE cao_campaign_worker AS (
		present TEXT[], id TEXT, workflow TEXT, enabled TEXT, max_mode TEXT)`); err != nil {
		t.Fatal(err)
	}

	if store, err := NewConfig(ctx, config); err == nil {
		_ = store.Close()
		t.Fatal("incompatible composite was accepted")
	} else if !errors.Is(err, ErrFreshDatabaseRequired) {
		t.Fatalf("incompatible composite lacks actionable error: %v", err)
	}
	var nativeTables int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_class WHERE
		relnamespace = current_schema()::regnamespace AND relkind = 'r'`).Scan(&nativeTables); err != nil || nativeTables != 0 {
		t.Fatalf("failed creation left partial tables: count=%d err=%v", nativeTables, err)
	}
}

func TestCurrentSourceCorruptionFailsClosed(t *testing.T) {
	for name, testCase := range map[string]struct{ source, corrupt string }{
		"document metadata": {"inventory", `DELETE FROM cao_source_documents WHERE source_name = 'inventory' AND ordinal = -1`},
		"canonical count":   {"$jobs", `UPDATE cao_counts SET count = count + 1 WHERE source_name = '$jobs'`},
		"classification":    {"$jobs", `UPDATE cao_sources SET is_canonical = FALSE WHERE source_name = '$jobs'`},
		"metadata presence": {"$jobs", `UPDATE cao_sources SET metadata_extension = NULL WHERE source_name = '$jobs'`},
		"metadata shadow":   {"$jobs", `UPDATE cao_sources SET metadata_extension = '{"source-id":"shadow"}'::json WHERE source_name = '$jobs'`},
	} {
		t.Run(name, func(t *testing.T) {
			ctx, config, db := schemaFixture(t)
			store, err := NewConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			sources := map[string]model.Source{
				"$jobs": {Source: "$jobs", Rows: []model.Row{{"id": "job"}},
					Metadata: model.Metadata{"source-id": "$jobs"}},
				"inventory": {Source: "inventory", Rows: []model.Row{{"keep": true}}},
			}
			if _, err := store.Replace(ctx, sources, model.Diagnostics{}, "valid", time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, testCase.corrupt); err != nil {
				t.Fatal(err)
			}
			if _, _, err := store.LoadSource(ctx, testCase.source, nil); err == nil || errors.Is(err, ErrSourceUnavailable) {
				t.Fatalf("corrupt current source must fail, not disappear or use legacy storage: %v", err)
			}
			// Replacement repairs the disposable projection, not initialization.
			if _, err := store.Replace(ctx, sources, model.Diagnostics{}, "rebuilt", time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			got, _, err := store.LoadSource(ctx, testCase.source, nil)
			if err != nil || !reflect.DeepEqual(got.Rows, sources[testCase.source].Rows) {
				t.Fatalf("authoritative replacement did not restore source: %+v %v", got, err)
			}
		})
	}
}
