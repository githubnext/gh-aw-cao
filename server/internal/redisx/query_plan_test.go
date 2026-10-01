package redisx

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type aggregatePlanClient struct {
	commands [][]string
}

func (client *aggregatePlanClient) Do(_ context.Context, command ...string) (any, error) {
	client.commands = append(client.commands, append([]string(nil), command...))
	if command[0] == "HGET" {
		switch command[2] {
		case "source:runs:metadata":
			return `{"availability":"available"}`, nil
		case "source:runs:format":
			return "json", nil
		case "source:runs:index-schema":
			return `[{"name":"conclusion","alias":"conclusion","kind":"TAG"},{"name":"workflow-role","alias":"workflow_role","kind":"TAG"}]`, nil
		case "source:runs:indexed-fields":
			return `["conclusion","workflow-role"]`, nil
		}
	}
	return []any{int64(1), []any{"id", `"3"`, "label", "failed worker"}}, nil
}

func (*aggregatePlanClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

// dialectArrayPlanClient simulates a real Redis 8 FT.AGGREGATE response under
// DIALECT 4, where JSONPath LOAD fields come back wrapped in a single-element
// array instead of being unwrapped to a scalar, and the generation has never
// recorded source metadata (so the stored value is the JSON literal "null").
type dialectArrayPlanClient struct{}

func (*dialectArrayPlanClient) Do(_ context.Context, command ...string) (any, error) {
	if command[0] == "HGET" {
		switch command[2] {
		case "source:runs:metadata":
			return "null", nil
		case "source:runs:format":
			return "json", nil
		case "source:runs:index-schema":
			return `[]`, nil
		case "source:runs:indexed-fields":
			return `[]`, nil
		}
	}
	return []any{int64(1), []any{"id", `["3"]`, "label", "failed worker"}}, nil
}

func TestNativeAggregateCommandUsesTypedFiltersAndReducers(t *testing.T) {
	limit := 5
	definition := query.Definition{
		Name: "run-summary", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "duration", GTE: 4, LT: 10}}},
		Aggregate: &query.Aggregate{
			By: []string{"conclusion"},
			Values: []query.AggregateValue{
				{Field: "id", As: "runs", Reducer: "count"},
				{Field: "duration", As: "mean-duration", Reducer: "mean"},
			},
		},
		Select:  []query.SelectedField{{Field: "conclusion"}, {Field: "runs"}, {Field: "mean-duration"}},
		OrderBy: []query.OrderField{{Field: "mean-duration", Direction: "desc"}},
		Limit:   &limit,
	}
	fields := []indexField{
		{Name: "conclusion", Alias: "conclusion", Kind: indexFieldTag, Required: true},
		{Name: "duration", Alias: "duration", Kind: indexFieldNumeric, Required: true},
		{Name: "id", Alias: "id", Kind: indexFieldTag, Required: true},
	}

	command, output, err := nativeAggregateCommand("runs-index", definition, fields)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.Join(command, "\x00")
	for _, expected := range []string{
		"@duration:[4 (10]", "GROUPBY\x001\x00@conclusion", "REDUCE\x00COUNT\x000\x00AS\x00runs",
		"REDUCE\x00AVG\x001\x00@duration\x00AS\x00mean_duration", "SORTBY\x002\x00@mean_duration\x00DESC",
	} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("native aggregate is missing %q: %v", expected, command)
		}
	}
	if output["mean_duration"].name != "mean-duration" {
		t.Fatalf("unexpected aggregate output mapping: %#v", output)
	}
}

func TestNativeAggregateCommandRejectsCountOfOptionalField(t *testing.T) {
	definition := query.Definition{
		Name: "counts", From: "runs",
		Aggregate: &query.Aggregate{Values: []query.AggregateValue{{Field: "optional", As: "count", Reducer: "count"}}},
		Select:    []query.SelectedField{{Field: "count"}},
	}
	_, _, err := nativeAggregateCommand("runs-index", definition, []indexField{
		{Name: "optional", Alias: "optional", Kind: indexFieldTag},
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported Redis reducer") {
		t.Fatalf("optional-field count should fail closed, got %v", err)
	}
}

func TestNativeAggregateCommandCountsLiteralComputedField(t *testing.T) {
	definition := query.Definition{
		Name: "count", From: "runs",
		Compute: []query.ComputedField{{
			As: "table", Function: "literal", Args: []query.Argument{{Value: "runs"}},
		}},
		Aggregate: &query.Aggregate{
			By:     []string{"table"},
			Values: []query.AggregateValue{{Field: "table", As: "records", Reducer: "count"}},
		},
		Select: []query.SelectedField{{Field: "table"}, {Field: "records"}},
	}
	command, _, err := nativeAggregateCommand("runs-index", definition, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.Join(command, "\x00")
	for _, expected := range []string{"APPLY\x00\"runs\"\x00AS\x00table", "GROUPBY\x001\x00@table", "REDUCE\x00COUNT\x000"} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("literal aggregate is missing %q: %v", expected, command)
		}
	}
}

func TestNativeAggregateCommandAppliesNumericComputations(t *testing.T) {
	duration := "duration"
	definition := query.Definition{
		Name: "computed", From: "runs",
		Compute: []query.ComputedField{
			{As: "doubled", Function: "product", Args: []query.Argument{{Field: &duration}, {Value: 2}}},
			{As: "slow", Function: "greater-than", Args: []query.Argument{{Field: &duration}, {Value: 5}}},
		},
		Select: []query.SelectedField{{Field: "doubled"}, {Field: "slow"}},
	}
	command, output, err := nativeAggregateCommand("runs-index", definition, []indexField{
		{Name: "duration", Alias: "duration", Kind: indexFieldNumeric, Required: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.Join(command, "\x00")
	for _, expected := range []string{
		"APPLY\x00(@duration*2)\x00AS\x00doubled", "APPLY\x00(@duration>5)\x00AS\x00slow",
	} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("numeric APPLY pipeline is missing %q: %v", expected, command)
		}
	}
	if !output["doubled"].numeric || !output["slow"].boolean {
		t.Fatalf("computed output types were not preserved: %#v", output)
	}
}

func (*dialectArrayPlanClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

func TestExecutePlanUnwrapsDialectFourArraysAndToleratesMissingMetadata(t *testing.T) {
	store := NewStore(&dialectArrayPlanClient{}, "native")
	definition := query.Definition{
		Name: "native-failures", From: "runs",
		Compute: []query.ComputedField{{
			As: "label", Function: "literal", Args: []query.Argument{{Value: "failed worker"}},
		}},
		Select: []query.SelectedField{{Field: "id"}, {Field: "label"}},
	}

	result, _, err := store.ExecutePlan(
		t.Context(), "generation", []query.Definition{definition}, []string{definition.Name},
		[]string{"runs", definition.Name}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	row := result[definition.Name].Rows[0]
	if row["id"] != "3" {
		t.Fatalf("JSONPath LOAD field was not unwrapped from its DIALECT 4 array: %#v", row)
	}
	if row["label"] != "failed worker" {
		t.Fatalf("computed APPLY field was unexpectedly unwrapped: %#v", row)
	}
}

func TestExecutePlanUsesNativeAggregatePipeline(t *testing.T) {
	client := &aggregatePlanClient{}
	store := NewStore(client, "native")
	limit := 1
	definition := query.Definition{
		Name: "native-failures", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "conclusion", In: []any{"failure"}},
			{Field: "workflow-role", Equals: "worker"},
		}},
		Compute: []query.ComputedField{{
			As: "label", Function: "literal", Args: []query.Argument{{Value: "failed worker"}},
		}},
		Select:  []query.SelectedField{{Field: "id"}, {Field: "label"}},
		OrderBy: []query.OrderField{{Field: "id", Direction: "desc"}},
		Limit:   &limit,
	}

	result, metrics, err := store.ExecutePlan(
		t.Context(), "generation", []query.Definition{definition}, []string{definition.Name},
		[]string{"runs", definition.Name}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := result[definition.Name].Rows; len(got) != 1 || got[0]["id"] != "3" || got[0]["label"] != "failed worker" {
		t.Fatalf("unexpected native rows: %#v", got)
	}
	if len(metrics.FallbackOperations) != 0 || !reflect.DeepEqual(metrics.PushedDown, []string{"redis-query-engine"}) {
		t.Fatalf("unexpected native metrics: %+v", metrics)
	}
	command := client.commands[len(client.commands)-1]
	if command[0] != "FT.AGGREGATE" {
		t.Fatalf("query used %q instead of FT.AGGREGATE: %v", command[0], command)
	}
	encoded := strings.Join(command, "\x00")
	for _, expected := range []string{
		"@conclusion:{failure} @workflow_role:{worker}", "LOAD", "APPLY", "SORTBY", "LIMIT", "DIALECT\x004",
	} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("native query is missing %q: %v", expected, command)
		}
	}
	for _, argument := range command {
		if argument == "EVAL" || argument == "SMEMBERS" || argument == "JSON.GET" {
			t.Fatalf("native query scanned rows with %q: %v", argument, command)
		}
	}
}
