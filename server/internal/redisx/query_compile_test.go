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
		{Name: "unsupported", From: "runs", Predict: []json.RawMessage{json.RawMessage(`{}`)}},
	}
	results, err := CompileQueries(definitions)
	if err != nil {
		t.Fatal(err)
	}
	levels := map[string]string{}
	for _, result := range results {
		levels[result.Name] = result.Level
	}
	for name, expected := range map[string]string{
		"native": "full candidate", "partial": "partial candidate",
		"dependent": "fallback", "unsupported": "unsupported",
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
