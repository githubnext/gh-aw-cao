package query

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type testLoader struct {
	sources map[string]model.Source
}

func (loader *testLoader) LoadSource(name string, _ *Definition) (model.Source, model.Metrics, error) {
	source, ok := loader.sources[name]
	if !ok {
		return model.Source{}, model.Metrics{}, nil
	}
	source.Source = name
	return source, model.Metrics{}, nil
}

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

func TestExecuteReportsPrivacyPreservingStructureAndPerformanceMetrics(t *testing.T) {
	limit := 1
	definition := Definition{
		Name:  "private-query-name",
		From:  "private-source-name",
		Union: []string{"other-private-source"},
		Joins: []Join{{
			Source: "private-join-source",
			Type:   "left",
			On:     []JoinKey{{Left: "secret-left-field", Right: "secret-right-field"}},
			Fields: []SelectedField{{Field: "secret-value", As: "private-alias"}},
		}},
		Filter:  &Filter{Predicates: []Predicate{{Field: "secret-field", Equals: "secret-value"}}},
		Compute: []ComputedField{{As: "computed", Function: "literal", Args: []Argument{{Value: "private-literal"}}}},
		Aggregate: &Aggregate{Values: []AggregateValue{{
			Field: "secret-field", As: "count", Reducer: "count",
		}}},
		Select:  []SelectedField{{Field: "count"}},
		OrderBy: []OrderField{{Field: "count"}},
		Limit:   &limit,
	}
	loader := &testLoader{sources: map[string]model.Source{
		"private-source-name":  {Rows: []model.Row{{"secret-field": "secret-value"}}},
		"other-private-source": {Rows: []model.Row{}},
		"private-join-source":  {Rows: []model.Row{}},
	}}

	sources, metrics, err := New(loader).Execute([]Definition{definition}, []string{definition.Name})
	if err != nil {
		t.Fatal(err)
	}
	if len(sources[definition.Name].Rows) != 1 || metrics.Operations == 0 || metrics.OutputRows != 1 {
		t.Fatalf("unexpected execution metrics: %#v", metrics)
	}
	if metrics.DependencyDepth != 1 || metrics.PeakWorkingRows != 1 || metrics.RetainedRows != 1 ||
		metrics.PeakWorkingBytes == 0 || metrics.RetainedBytes == 0 {
		t.Fatalf("unexpected resource metrics: %#v", metrics)
	}
	if metrics.QueryCount != 1 || metrics.UnionCount != 1 || metrics.JoinCount != 1 ||
		metrics.FilterCount != 1 || metrics.ComputeCount != 1 || metrics.AggregateCount != 1 ||
		metrics.AggregateValueCount != 1 || metrics.SelectCount != 1 ||
		metrics.OrderByCount != 1 || metrics.LimitCount != 1 {
		t.Fatalf("unexpected structural metrics: %#v", metrics)
	}
	encoded, err := json.Marshal(metrics)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{
		definition.Name, definition.From, "secret-field", "secret-value", "private-alias", "private-literal",
	} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("metrics exposed private query content %q: %s", private, encoded)
		}
	}
}

func TestExecuteRejectsExcessiveDependencyDepth(t *testing.T) {
	definitions := make([]Definition, MaxDependencyDepth+1)
	previous := "rows"
	for index := range definitions {
		name := fmt.Sprintf("query-%d", index)
		definitions[index] = Definition{Name: name, From: previous}
		previous = name
	}
	_, _, err := New(&testLoader{sources: map[string]model.Source{
		"rows": {Rows: []model.Row{}},
	}}).Execute(definitions, []string{definitions[len(definitions)-1].Name})
	if err == nil || !strings.Contains(err.Error(), "max depth") {
		t.Fatalf("expected dependency-depth guard, got %v", err)
	}
}

func TestExecuteRejectsTooManyJoinsAcrossDependencyPath(t *testing.T) {
	definitions := make([]Definition, MaxDependencyJoins/MaxJoins+1)
	previous := "rows"
	for index := range definitions {
		joins := make([]Join, MaxJoins)
		for joinIndex := range joins {
			joins[joinIndex] = Join{
				Source: fmt.Sprintf("join-%d-%d", index, joinIndex),
				On:     []JoinKey{{Left: "id", Right: "id"}},
			}
		}
		definitions[index] = Definition{
			Name:  fmt.Sprintf("query-%d", index),
			From:  previous,
			Joins: joins,
		}
		previous = definitions[index].Name
	}
	_, _, err := New(&testLoader{}).Execute(definitions, []string{definitions[len(definitions)-1].Name})
	if err == nil || !strings.Contains(err.Error(), "max joins") {
		t.Fatalf("expected cumulative-join guard, got %v", err)
	}
}

func TestExecuteRejectsExcessiveWorkingAndRetainedRows(t *testing.T) {
	rows := make([]model.Row, MaxInputRows)
	t.Run("working rows", func(t *testing.T) {
		definition := Definition{
			Name: "wide", From: "base",
			Joins: []Join{
				{Source: "join-a", On: []JoinKey{{Left: "id", Right: "id"}}},
				{Source: "join-b", On: []JoinKey{{Left: "id", Right: "id"}}},
			},
		}
		_, _, err := New(&testLoader{sources: map[string]model.Source{
			"base": {Rows: rows}, "join-a": {Rows: rows}, "join-b": {Rows: rows},
		}}).Execute([]Definition{definition}, []string{definition.Name})
		if err == nil || !strings.Contains(err.Error(), "max working rows") {
			t.Fatalf("expected working-row guard, got %v", err)
		}
	})
	t.Run("retained rows", func(t *testing.T) {
		_, _, err := New(&testLoader{sources: map[string]model.Source{
			"one": {Rows: rows}, "two": {Rows: rows}, "three": {Rows: rows},
		}}).Execute(nil, []string{"one", "two", "three"})
		if err == nil || !strings.Contains(err.Error(), "max retained rows") {
			t.Fatalf("expected retained-row guard, got %v", err)
		}
	})
	t.Run("working bytes", func(t *testing.T) {
		large := strings.Repeat("x", 1<<20)
		byteRows := make([]model.Row, 300)
		for index := range byteRows {
			byteRows[index] = model.Row{"value": large}
		}
		definition := Definition{Name: "large", From: "rows"}
		_, _, err := New(&testLoader{sources: map[string]model.Source{
			"rows": {Rows: byteRows},
		}}).Execute([]Definition{definition}, []string{definition.Name})
		if err == nil || !strings.Contains(err.Error(), "max working bytes") {
			t.Fatalf("expected working-byte guard, got %v", err)
		}
	})
}

func TestExecuteDefinitionRejectsRunawayStageBeforeAllocation(t *testing.T) {
	fields := make([]ComputedField, 128)
	for index := range fields {
		fields[index] = ComputedField{
			As: fmt.Sprintf("field-%d", index), Function: "literal", Args: []Argument{{Value: index}},
		}
	}
	_, operations, _, err := ExecuteDefinition(Definition{
		Name: "runaway", From: "rows", Compute: fields,
	}, map[string]model.Source{
		"rows": {Rows: make([]model.Row, 50_000)},
	}, MaxOperations)
	if err == nil || !strings.Contains(err.Error(), "max operations") {
		t.Fatalf("expected operation guard, got operations=%d err=%v", operations, err)
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

func TestLinkHrefComputedField(t *testing.T) {
	definition := Definition{
		Name: "links", From: "rows",
		Compute: []ComputedField{{
			As: "href", Function: "link-href",
			Args: []Argument{fieldArgument("link")},
		}},
	}
	if err := Validate([]Definition{definition}); err != nil {
		t.Fatal(err)
	}

	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"rows": {Rows: []model.Row{
			{"link": map[string]any{"href": "https://github.example/workflow.yml", "label": "Workflow"}},
			{"link": map[string]any{"href": ""}},
			{"link": "not-a-link"},
		}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0]["href"] != "https://github.example/workflow.yml" {
		t.Fatalf("unexpected link href: %#v", result.Rows[0]["href"])
	}
	if result.Rows[1]["href"] != nil || result.Rows[2]["href"] != nil {
		t.Fatalf("invalid links did not produce null: %#v", result.Rows)
	}
}

func TestLiteralComputedField(t *testing.T) {
	definition := Definition{
		Name: "labels", From: "rows",
		Compute: []ComputedField{{
			As: "label", Function: "literal",
			Args: []Argument{{Value: "workflow runs"}},
		}},
	}
	if err := Validate([]Definition{definition}); err != nil {
		t.Fatal(err)
	}

	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"rows": {Rows: []model.Row{{"id": "1"}, {"id": "2"}}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 2 || result.Rows[0]["label"] != "workflow runs" || result.Rows[1]["label"] != "workflow runs" {
		t.Fatalf("unexpected literal labels: %#v", result.Rows)
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

func TestUnavailableUnionFailsClosed(t *testing.T) {
	definition := Definition{
		Name:  "combined",
		From:  "available",
		Union: []string{"unavailable"},
	}
	result, _, _, err := ExecuteDefinition(definition, map[string]model.Source{
		"available": {
			Rows:     []model.Row{{"id": "1"}},
			Metadata: model.Metadata{"availability": "available"},
		},
		"unavailable": {
			Rows:     []model.Row{},
			Metadata: model.Metadata{"availability": "unavailable"},
		},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 0 || result.Metadata["availability"] != "unavailable" {
		t.Fatalf("unavailable union input did not fail closed: %#v", result)
	}
	if got := result.Metadata["query-error"]; !reflect.DeepEqual(got, map[string]string{
		"code": "input-unavailable", "source": "unavailable",
	}) {
		t.Fatalf("unavailable union input error = %#v", got)
	}
}

func TestUnavailablePrimaryInputIdentifiesDependency(t *testing.T) {
	result, _, _, err := ExecuteDefinition(Definition{Name: "mcp-top-tools", From: "mcp-tool-totals"}, map[string]model.Source{
		"mcp-tool-totals": {Metadata: model.Metadata{"availability": "unavailable"}},
	}, MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if got := result.Metadata["query-error"]; !reflect.DeepEqual(got, map[string]string{
		"code": "input-unavailable", "source": "mcp-tool-totals",
	}) {
		t.Fatalf("unavailable primary input error = %#v", got)
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

func TestDistinctValuesSortsAndDeduplicates(t *testing.T) {
	got := distinctValues([]any{"beta", "alpha", "beta", 1, 1})
	want := []string{"1", "alpha", "beta"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestDistinctValuesEmptyInput(t *testing.T) {
	if got := distinctValues(nil); len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestNumericReduceSumIncludesZeroValues(t *testing.T) {
	result, ok := numericReduce([]float64{1, 2, 3}, "sum")
	if !ok {
		t.Fatal("sum should be a supported reducer")
	}
	if result != float64(6) {
		t.Fatalf("got %v, want 6", result)
	}
	result, ok = numericReduce(nil, "sum")
	if !ok || result != float64(0) {
		t.Fatalf("empty sum: got %v, %v, want 0, true", result, ok)
	}
}

func TestNumericReduceMeanMinMaxTreatEmptyAsNil(t *testing.T) {
	for _, reducer := range []string{"mean", "min", "max"} {
		result, ok := numericReduce(nil, reducer)
		if !ok || result != nil {
			t.Fatalf("reducer %q on empty input: got %v, %v, want nil, true", reducer, result, ok)
		}
	}
	result, ok := numericReduce([]float64{4, 1, 3}, "mean")
	if !ok || result != float64(8)/3 {
		t.Fatalf("mean: got %v, %v, want %v, true", result, ok, float64(8)/3)
	}
	result, ok = numericReduce([]float64{4, 1, 3}, "min")
	if !ok || result != float64(1) {
		t.Fatalf("min: got %v, %v, want 1, true", result, ok)
	}
	result, ok = numericReduce([]float64{4, 1, 3}, "max")
	if !ok || result != float64(4) {
		t.Fatalf("max: got %v, %v, want 4, true", result, ok)
	}
}

func TestNumericReduceUnsupportedReducerReportsNotOK(t *testing.T) {
	result, ok := numericReduce([]float64{1, 2}, "median")
	if ok {
		t.Fatalf("expected ok=false for unsupported reducer, got result %v", result)
	}
	if result != nil {
		t.Fatalf("got %v, want nil", result)
	}
}

func TestReduceUnsupportedReducerReturnsNil(t *testing.T) {
	// Validate rejects unsupported reducers before Execute runs; reduce
	// still fails closed to nil if one ever reaches it directly.
	if result := reduce([]any{1, 2, 3}, "median"); result != nil {
		t.Fatalf("got %v, want nil", result)
	}
}
