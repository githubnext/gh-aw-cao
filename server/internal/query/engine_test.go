package query

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestExecuteDefinitionPipeline(t *testing.T) {
	limit := 2
	definition := Definition{
		Name: "summary", From: "runs",
		Joins: []Join{{
			Source: "repositories", Type: "left",
			On:     []JoinKey{{Left: "repositoryId", Right: "id"}},
			Fields: []SelectedField{{Field: "name", As: "repository"}},
		}},
		Filter: &Filter{Predicates: []Predicate{{Field: "conclusion", In: []any{"success", "failure"}}}},
		Compute: []ComputedField{{
			As: "failed", Function: "equals-any",
			Args: []Argument{fieldArgument("conclusion"), {Value: "failure"}},
		}},
		Aggregate: &Aggregate{
			By: []string{"repository"},
			Values: []AggregateValue{
				{Field: "id", As: "runs", Reducer: "count"},
				{Field: "model", As: "models", Reducer: "distinct-values"},
				{Field: "duration", As: "mean-duration", Reducer: "mean"},
				{Field: "id", As: "failures", Reducer: "count", Filter: &Filter{Predicates: []Predicate{{Field: "failed", Equals: true}}}},
			},
		},
		OrderBy: []OrderField{{Field: "runs", Direction: "desc"}},
		Limit:   &limit,
	}
	sources := map[string]model.Source{
		"runs": {Rows: []model.Row{
			{"id": "1", "repositoryId": "r1", "conclusion": "success", "duration": 4, "model": "a"},
			{"id": "2", "repositoryId": "r1", "conclusion": "failure", "duration": 8, "model": "b"},
			{"id": "3", "repositoryId": "r2", "conclusion": "cancelled", "duration": 2, "model": "a"},
		}, Metadata: model.Metadata{"availability": "available"}},
		"repositories": {Rows: []model.Row{{"id": "r1", "name": "alpha"}, {"id": "r2", "name": "beta"}}},
	}
	result, _, _, err := ExecuteDefinition(definition, sources, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(result.Rows))
	}
	row := result.Rows[0]
	if row["repository"] != "alpha" || row["runs"] != 2 || row["failures"] != 1 || row["mean-duration"] != float64(6) {
		t.Fatalf("unexpected aggregate row: %#v", row)
	}
	models, ok := row["models"].([]string)
	if !ok || strings.Join(models, ",") != "a,b" {
		t.Fatalf("unexpected distinct values: %#v", row["models"])
	}
}

func TestEmptyAggregateBehavior(t *testing.T) {
	definition := Definition{
		Name: "empty", From: "rows",
		Aggregate: &Aggregate{Values: []AggregateValue{
			{Field: "id", As: "count", Reducer: "count"},
			{Field: "value", As: "sum", Reducer: "sum"},
			{Field: "value", As: "mean", Reducer: "mean"},
		}},
	}

	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{"rows": {Rows: nil}}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0]["count"] != 0 || result.Rows[0]["sum"] != float64(0) || result.Rows[0]["mean"] != nil {
		t.Fatalf("unexpected empty aggregate: %#v", result.Rows)
	}
}

func TestAggregateOmitsMissingGroupFields(t *testing.T) {
	definition := Definition{
		Name: "grouped",
		From: "runs",
		Aggregate: &Aggregate{
			By:     []string{"target"},
			Values: []AggregateValue{{Field: "id", As: "runs", Reducer: "count"}},
		},
	}
	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"runs": {Rows: []model.Row{{"id": "1"}}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := result.Rows[0]["target"]; present {
		t.Fatalf("missing group field was materialized: %#v", result.Rows[0])
	}
}

func TestJoinRejectsDuplicateRightKeys(t *testing.T) {
	definition := Definition{
		Name: "joined", From: "runs",
		Joins: []Join{{
			Source: "workflows", Type: "left",
			On:     []JoinKey{{Left: "workflow", Right: "workflow"}},
			Fields: []SelectedField{{Field: "name", As: "workflow-name"}},
		}},
	}
	_, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"runs": {Rows: []model.Row{{"workflow": "build.yml"}}},
		"workflows": {Rows: []model.Row{
			{"workflow": "build.yml", "name": "Build"},
			{"workflow": "build.yml", "name": "Duplicate"},
		}},
	}, MaxOperations)
	if err == nil || !strings.Contains(err.Error(), "more than one row per join key") {
		t.Fatalf("expected duplicate join-key rejection, got %v", err)
	}
}

func TestLeftJoinDoesNotMatchBlankKeys(t *testing.T) {
	definition := Definition{
		Name: "joined", From: "runs",
		Joins: []Join{{
			Source: "workflows", Type: "left",
			On:     []JoinKey{{Left: "workflow", Right: "workflow"}},
			Fields: []SelectedField{{Field: "name", As: "workflow-name"}},
		}},
	}
	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"runs":      {Rows: []model.Row{{"workflow": ""}}},
		"workflows": {Rows: []model.Row{{"workflow": "", "name": "Blank"}}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0]["workflow-name"] != nil {
		t.Fatalf("blank join keys matched unexpectedly: %#v", result.Rows)
	}
}

func TestPredictionFailsClosed(t *testing.T) {
	definitionsJSON := `[{"name":"forecast","from":"runs","predict":[{"field":"y","on":"x","as":"p"}]}]`
	var definitions []Definition
	if err := json.Unmarshal([]byte(definitionsJSON), &definitions); err != nil {
		t.Fatal(err)
	}
	err := Validate(definitions)
	if err == nil || !strings.Contains(err.Error(), "prediction") {
		t.Fatalf("expected explicit prediction error, got %v", err)
	}
}

func TestTemporalSeries(t *testing.T) {
	definition := Definition{
		Name: "series", From: "usage",
		TemporalSeries: &TemporalSeries{
			Time: "at", Series: "model",
			Measures: []TemporalMeasure{{Field: "tokens", Kind: "usage"}},
		},
	}
	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"usage": {Rows: []model.Row{{"at": "2026-01-01T00:00:00Z", "model": "gpt", "tokens": 12}}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0]["metric-key"] != "usage:tokens" || result.Rows[0]["value"] != float64(12) {
		t.Fatalf("unexpected temporal projection: %#v", result.Rows)
	}
}

func TestLeftJoinPreservesMissingFieldsAsNull(t *testing.T) {
	definition := Definition{
		Name: "joined",
		From: "runs",
		Joins: []Join{{
			Source: "records",
			Type:   "left",
			On:     []JoinKey{{Left: "id", Right: "run"}},
			Fields: []SelectedField{{Field: "events", As: "imported-events"}},
		}},
	}
	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"runs":    {Rows: []model.Row{{"id": "1"}}},
		"records": {Rows: []model.Row{}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(result.Rows))
	}
	value, present := result.Rows[0]["imported-events"]
	if !present || value != nil {
		t.Fatalf("missing selected field was not preserved as null: %#v", result.Rows[0])
	}
}

func fieldArgument(name string) Argument { return Argument{Field: &name} }
