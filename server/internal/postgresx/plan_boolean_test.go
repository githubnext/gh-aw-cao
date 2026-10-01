package postgresx

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestSimplePlanCanonicalScalarEquality(t *testing.T) {
	for _, tc := range []struct {
		source, field string
		value         any
		supported     bool
	}{
		{"$campaigns", "enabled", false, true},
		{"$issues", "isPullRequest", true, true},
		{"$issues", "isPullRequest", "true", false},
		{"$campaigns", "enabled", nil, false},
		{"$runs", "attempt", json.Number("2"), true},
		{"$runs", "attempt", "2", true},
		{"$runs", "attempt", true, false},
		{"$unknown", "enabled", true, false},
		{"$campaigns", "status", true, false},
	} {
		definitions := []query.Definition{{
			Name: "picked", From: tc.source,
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: tc.field, Equals: tc.value}}},
		}}
		_, _, supported := simplePlan(definitions, []string{"picked"}, []string{"picked"})
		if supported != tc.supported {
			t.Errorf("%s %s=%v: supported=%t, want %t", tc.source, tc.field, tc.value, supported, tc.supported)
		}
	}
}

func TestNativeScalarFilterMatchesEvaluator(t *testing.T) {
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
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_boolean_plan_%d", time.Now().UnixNano())
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
	source := model.Source{Source: "$campaigns", Metadata: model.Metadata{"availability": "available"},
		Rows: []model.Row{
			{"id": "a", "enabled": true},
			{"id": "b", "enabled": false},
			{"id": "c", "enabled": nil},
			{"id": "d"},
		}}
	runs := model.Source{Source: "$runs", Metadata: model.Metadata{"availability": "available"},
		Rows: []model.Row{
			{"id": "run-a", "attempt": json.Number("1")},
			{"id": "run-b", "attempt": json.Number("1.0")},
			{"id": "run-c", "attempt": json.Number("1e0")},
			{"id": "run-d", "attempt": json.Number("1e1000000")},
			{"id": "run-e", "attempt": nil},
			{"id": "run-f"},
		}}
	if _, err := store.Replace(ctx, map[string]model.Source{"$campaigns": source, "$runs": runs},
		model.Diagnostics{}, "boolean-test", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		source, field string
		value         any
	}{
		{"$campaigns", "enabled", true},
		{"$campaigns", "enabled", false},
		{"$runs", "attempt", "1"},
		{"$runs", "attempt", json.Number("1.0")},
		{"$runs", "attempt", "1e0"},
		{"$runs", "attempt", "1e1000000"},
	} {
		definitions := []query.Definition{{
			Name: "picked", From: tc.source,
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: tc.field, Equals: tc.value}}},
			Select: []query.SelectedField{{Field: "id"}, {Field: tc.field}},
		}}
		expected, _, err := query.New(sourceLoader{store: store, ctx: ctx}).Execute(definitions, []string{"picked"})
		if err != nil {
			t.Fatal(err)
		}
		err = store.WithReadTransaction(ctx, func(reader SourceReader) error {
			got, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(
				ctx, definitions, []string{"picked"}, []string{"picked"})
			if err != nil {
				return err
			}
			if !supported || !reflect.DeepEqual(got["picked"].Rows, expected["picked"].Rows) {
				t.Errorf("%s=%v: supported=%t, got=%#v, want=%#v",
					tc.field, tc.value, supported, got["picked"].Rows, expected["picked"].Rows)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
