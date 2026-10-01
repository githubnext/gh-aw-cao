package ingest

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestMaterializeDashboardQueriesStagesSignedStaticResults(t *testing.T) {
	field := "duration"
	sources := map[string]model.Source{
		"runs": {Source: "runs", Rows: []model.Row{{"duration": 2.0}, {"duration": 4.0}}},
	}
	definitions := []query.Definition{
		{
			Name: "duration-total", From: "runs",
			Aggregate: &query.Aggregate{Values: []query.AggregateValue{{Field: field, As: "total", Reducer: "sum"}}},
			Select:    []query.SelectedField{{Field: "total"}},
		},
		{
			Name: "dynamic", From: "runs",
			Compute: []query.ComputedField{{As: "window", Function: "literal", Args: []query.Argument{{Context: "time-window"}}}},
		},
	}

	count, err := materializeDashboardQueries(sources, definitions)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("materialized %d queries, want 1", count)
	}
	result := sources["duration-total"]
	if len(result.Rows) != 1 || result.Rows[0]["total"] != 6.0 {
		t.Fatalf("unexpected materialized rows: %#v", result.Rows)
	}
	if result.Metadata[query.MaterializedSignatureMetadata] == "" {
		t.Fatalf("materialized source is unsigned: %#v", result.Metadata)
	}
	if _, exists := sources["dynamic"]; exists {
		t.Fatal("dynamic query was materialized")
	}
}
