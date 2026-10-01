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
		case "source:runs:indexed-fields":
			return `["conclusion","workflow-role"]`, nil
		}
	}
	return []any{int64(1), []any{"id", `"3"`, "label", "failed worker"}}, nil
}

func (*aggregatePlanClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

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
