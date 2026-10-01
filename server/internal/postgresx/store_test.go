package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
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

func TestStoreIntegration(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	admin, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("cao_postgresx_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schema
	dsn := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(dsn)
	store, err := New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

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
	sources := map[string]model.Source{
		"$runs": {
			Source: "$runs",
			Rows: []model.Row{
				{"id": "raw-1", "nested": map[string]any{"large": json.Number("9007199254740993")}},
			},
			Metadata: model.Metadata{"kind": "canonical"},
		},
		"repositories": {
			Source: "repositories",
			Rows: []model.Row{
				{"id": "a", "count": json.Number("9007199254740993")},
				{"id": "b", "count": json.Number("2")},
			},
			Metadata: model.Metadata{"origin": "inventory", "version": json.Number("3")},
		},
		"empty": {Source: "empty", Rows: []model.Row{}, Metadata: model.Metadata{"origin": "inventory"}},
	}
	diagnostics := model.Diagnostics{SchemaVersion: model.SchemaVersion, Counts: map[string]int{"repositories": 2}, RelationshipErrors: []string{"test diagnostic"}}
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
		!reflect.DeepEqual(state.Counts, map[string]int{"$runs": 1, "repositories": 2, "empty": 0}) {
		t.Fatalf("unexpected state: %+v", state)
	}
	tenant, err := New(ctx, dsn, "other-tenant")
	if err != nil {
		t.Fatal(err)
	}
	defer tenant.Close()
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
