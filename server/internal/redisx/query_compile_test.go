package redisx

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestCompileQueriesClassifiesNativePartialFallbackAndUnsupported(t *testing.T) {
	definitions := []query.Definition{
		{Name: "native", From: "runs", Select: []query.SelectedField{{Field: "id"}}},
		{Name: "partial", From: "runs", Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "status", Equals: "failure"}, {Field: "title", Includes: "timeout"},
		}}},
		{Name: "dependent", From: "native", Select: []query.SelectedField{{Field: "id"}}},
		{Name: "runtime", From: "collection-health", Select: []query.SelectedField{{Field: "id"}}},
		{Name: "unsupported", From: "runs", Predict: []json.RawMessage{json.RawMessage(`{}`)}},
	}
	results, err := CompileQueries(definitions, "collection-health")
	if err != nil {
		t.Fatal(err)
	}
	levels := map[string]string{}
	for _, result := range results {
		levels[result.Name] = result.Level
	}
	for name, expected := range map[string]string{
		"native": "full candidate", "partial": "partial candidate",
		"dependent": "fallback", "runtime": "fallback", "unsupported": "unsupported",
	} {
		if levels[name] != expected {
			t.Errorf("%s: got %q, want %q", name, levels[name], expected)
		}
	}
}

func TestCompileQueriesRejectsDuplicateNamesAndIndexAliases(t *testing.T) {
	_, err := CompileQueries([]query.Definition{{Name: "a", From: "runs"}, {Name: "a", From: "jobs"}})
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate name: %v", err)
	}

	results, err := CompileQueries([]query.Definition{{
		Name: "collision", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "a-b", Equals: "yes"}, {Field: "a_b", Equals: "yes"},
		}},
		Select: []query.SelectedField{{Field: "a-b"}},
	}})
	if err != nil || results[0].Level == "full candidate" {
		t.Fatalf("alias collision must not be reported as native: %v %#v", err, results)
	}
}

func TestCompileQueriesExplainsNativeBoundaryWithoutProjectingRequiredFields(t *testing.T) {
	results, err := CompileQueries([]query.Definition{
		{Name: "summary", From: "runs",
			Filter:    &query.Filter{Predicates: []query.Predicate{{Field: "status", Equals: "failure"}}},
			Aggregate: &query.Aggregate{By: []string{"workflow"}, Values: []query.AggregateValue{{Field: "duration", As: "total", Reducer: "sum"}}}},
		{Name: "passthrough", From: "runs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "status", Equals: "failure"}, {Field: "title", Includes: "timeout"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	passthrough := results[0]
	if passthrough.Name != "passthrough" || passthrough.Level != "partial candidate" ||
		passthrough.ResultShape.Mode != query.PreserveInput ||
		len(passthrough.NativePrefix) != 1 || passthrough.NativePrefix[0] != "indexed-candidates" ||
		len(passthrough.FallbackSuffix) != 1 || passthrough.FallbackSuffix[0] != "filter" {
		t.Fatalf("full-row search boundary is inaccurate: %+v", passthrough)
	}
	summary := results[1]
	if summary.Name != "summary" || summary.Level != "full candidate" ||
		summary.ResultShape.Mode != query.ClosedShape ||
		len(summary.ResultShape.Fields) != 2 ||
		summary.ResultShape.Fields[0].As != "workflow" || summary.ResultShape.Fields[1].As != "total" ||
		len(summary.RedisCommands) != 1 || summary.RedisCommands[0] != "FT.AGGREGATE" ||
		len(summary.FallbackSuffix) != 0 {
		t.Fatalf("aggregate compilation should close its output: %+v", summary)
	}
}
