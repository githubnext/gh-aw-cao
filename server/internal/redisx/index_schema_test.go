package redisx

import (
	"context"
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestIndexSchemaUsesDirectQueryFieldsAndTypes(t *testing.T) {
	duration := "duration"
	source := model.Source{Source: "runs", Rows: []model.Row{
		{"id": "1", "conclusion": "success", "duration": 4.5, "title": "First run", "unused": "not indexed"},
		{"id": "2", "conclusion": "failure", "duration": 8.0, "title": "Second run", "unused": "still ignored"},
	}}
	definitions := []query.Definition{{
		Name: "run-summary", From: "runs",
		Filter: &query.Filter{
			Predicates: []query.Predicate{{Field: "conclusion", Equals: "failure"}, {Field: "duration", GTE: 4}},
			Search:     &query.Search{Fields: []string{"title"}, Query: "run"},
		},
		Compute: []query.ComputedField{{As: "seconds", Function: "number", Args: []query.Argument{{Field: &duration}}}},
		Aggregate: &query.Aggregate{
			By:     []string{"conclusion"},
			Values: []query.AggregateValue{{Field: "duration", As: "mean-duration", Reducer: "mean"}},
		},
		OrderBy: []query.OrderField{{Field: "duration", Direction: "desc"}},
	}}

	fields, err := indexSchemaForSource(source, definitions)
	if err != nil {
		t.Fatal(err)
	}
	want := []indexField{
		{Name: "conclusion", Alias: "conclusion", Kind: indexFieldTag, Sortable: true, Required: true},
		{Name: "duration", Alias: "duration", Kind: indexFieldNumeric, Sortable: true, Required: true},
		{Name: "title", Alias: "title", Kind: indexFieldText, Required: true},
	}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("index schema = %#v, want %#v", fields, want)
	}
	for _, field := range fields {
		if field.Name == "unused" {
			t.Fatal("query-unreferenced scalar field was indexed")
		}
	}
}

type indexSchemaClient struct {
	commands [][]string
}

func (client *indexSchemaClient) Do(_ context.Context, command ...string) (any, error) {
	client.commands = append(client.commands, append([]string(nil), command...))
	return nil, nil
}

func (*indexSchemaClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }
