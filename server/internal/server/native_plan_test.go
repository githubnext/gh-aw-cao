package server

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestNativePlanDifferential(t *testing.T) {
	store := integrationDatabase(t)
	seedDatabase(t, store, map[string]model.Source{
		"$jobs": {
			Source: "$jobs",
			Rows: []model.Row{
				{"id": "one", "runId": "run-1", "value": json.Number("1e1000000"), "nested": map[string]any{"n": json.Number("9007199254740993")}},
				{"id": "two", "runId": "run-2", "value": nil},
				{"id": "three", "runId": "run-1", "nested": []any{nil, json.Number("1.25")}},
				{"id": "four", "runId": "unknown"},
				{"id": json.Number("1e1000000"), "runId": "run-3"},
				{"runId": "run-3"},
			},
			Metadata: model.Metadata{"source-id": "$jobs", "availability": "available", "row-count": 6},
		},
		"$other": {Source: "$other", Rows: []model.Row{{"id": "one"}, {"id": "one"}}},
	})
	base := query.Definition{Name: "jobs", From: "$jobs"}
	for _, test := range []struct {
		name       string
		definition query.Definition
		native     bool
	}{
		{"filtered projection", query.Definition{
			Name: "pick", From: "jobs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "runId", Equals: "run-1"}}},
			Select: []query.SelectedField{{Field: "id"}, {Field: "value"}, {Field: "nested"}, {Field: "missing"}, {Field: "runId", As: "run"}},
		}, true},
		{"nil and missing projection", query.Definition{
			Name: "pick", From: "jobs", Select: []query.SelectedField{{Field: "id"}, {Field: "value"}, {Field: "missing"}},
		}, true},
		{"indexed exact id", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "two"}}},
		}, true},
		{"huge exponent lexeme", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "1e1000000"}}},
		}, true},
		{"bound client value", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: `one' OR TRUE --`}}},
		}, true},
		{"bound projected field", query.Definition{
			Name: "pick", From: "jobs",
			Select: []query.SelectedField{{Field: "id"}, {Field: `value'); DROP TABLE cao_sources; -- {}`}},
		}, true},
		{"empty", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "absent"}}},
		}, true},
		{"unknown matches null", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "unknown"}}},
		}, false},
		{"null matches missing", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: nil}}},
		}, false},
		{"optional", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "one", Optional: true}}},
		}, false},
		{"case insensitive search", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Search: &query.Search{Fields: []string{"id"}, Query: "ONE"}},
		}, false},
		{"stable sort", query.Definition{Name: "pick", From: "jobs", OrderBy: []query.OrderField{{Field: "id", Direction: "desc"}}}, false},
		{"untrusted field", query.Definition{
			Name: "pick", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: `id"); DROP TABLE cao_sources; --`, Equals: "one"}}},
		}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			definitions := []query.Definition{base, test.definition}
			err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.SourceReader) error {
				loader := &databaseLoader{ctx: ctx, database: reader}
				native, metrics, err := query.New(loader).Execute(definitions, []string{"pick"})
				if err != nil {
					return err
				}
				fallback, fallbackMetrics, err := query.New(sourceOnlyLoader{loader: loader}).Execute(definitions, []string{"pick"})
				if err != nil {
					return err
				}
				if !reflect.DeepEqual(native, fallback) {
					t.Errorf("native/fallback mismatch: native=%#v fallback=%#v", native, fallback)
				}
				if test.native {
					if len(metrics.PushedDown) == 0 || len(metrics.FallbackOperations) != 0 {
						t.Errorf("expected native plan, metrics=%+v", metrics)
					}
					if metrics.Operations < fallbackMetrics.Operations {
						t.Errorf("native operation count undercharged: native=%d fallback=%d", metrics.Operations, fallbackMetrics.Operations)
					}
				} else if len(metrics.PushedDown) != 0 {
					t.Errorf("unsupported shape must fall back: %+v", metrics)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("duplicate join keys", func(t *testing.T) {
		definitions := []query.Definition{base, {
			Name: "pick", From: "jobs", Joins: []query.Join{{
				Source: "$other", On: []query.JoinKey{{Left: "id", Right: "id"}},
				Fields: []query.SelectedField{{Field: "id", As: "other"}},
			}},
		}}
		err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.SourceReader) error {
			loader := &databaseLoader{ctx: ctx, database: reader}
			_, _, err := query.New(loader).Execute(definitions, []string{"pick"})
			if err == nil || !strings.Contains(err.Error(), "more than one row per join key") {
				t.Errorf("duplicate join must fail in fallback: %v", err)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
}

func TestNativePlanRejectsUnfilteredExcessBeforePredicate(t *testing.T) {
	store := integrationDatabase(t)
	rows := make([]model.Row, query.MaxInputRows+1)
	for i := range rows {
		rows[i] = model.Row{}
	}

	seedDatabase(t, store, map[string]model.Source{"$jobs": {
		Source: "$jobs", Rows: rows,
	}})
	definitions := []query.Definition{{Name: "pick", From: "$jobs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "absent"}}}}}
	err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.SourceReader) error {
		loader := &databaseLoader{ctx: ctx, database: reader}
		for _, engine := range []*query.Engine{query.New(loader), query.New(sourceOnlyLoader{loader: loader})} {
			_, _, err := engine.Execute(definitions, []string{"pick"})
			if err == nil || !strings.Contains(err.Error(), "max input rows") {
				t.Errorf("pre-filter input bound was bypassed: %v", err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNativePlanUsesExistingHTTPPaginationContract(t *testing.T) {
	store := integrationDatabase(t)
	seedDatabase(t, store, map[string]model.Source{"$jobs": {
		Source: "$jobs", Rows: []model.Row{
			{"id": "first", "runId": "run-1"},
			{"id": "second", "runId": "run-1"},
			{"id": "third", "runId": "run-2"},
		},
	}})
	app := &App{database: store, databaseQueries: []query.Definition{{Name: "jobs", From: "$jobs"}}}
	input := queryRequest{
		SourceNames: []string{"pick"},
		CompiledQueries: []query.Definition{{Name: "pick", From: "jobs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "runId", Equals: "run-1"}}}}},
		Pagination: map[string]paginationRequest{"pick": {Limit: 1}},
	}
	first, status, err := app.executeQuery(t.Context(), input, false)
	if err != nil || status != http.StatusOK || len(first.Sources["pick"].Rows) != 1 ||
		first.Sources["pick"].Rows[0]["id"] != "first" ||
		first.Sources["pick"].Metadata["total-row-count"] != 2 ||
		first.Sources["pick"].ContinuationToken == "" || len(first.Metrics.PushedDown) == 0 {
		t.Fatalf("first page through native query: %+v status=%d err=%v", first, status, err)
	}
	input.Pagination["pick"] = paginationRequest{Limit: 1, ContinuationToken: first.Sources["pick"].ContinuationToken}
	second, status, err := app.executeQuery(t.Context(), input, false)
	if err != nil || status != http.StatusOK || len(second.Sources["pick"].Rows) != 1 ||
		second.Sources["pick"].Rows[0]["id"] != "second" || second.Sources["pick"].ContinuationToken != "" {
		t.Fatalf("second page through native query: %+v status=%d err=%v", second, status, err)
	}
}
