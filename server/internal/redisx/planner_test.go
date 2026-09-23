package redisx

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestPlanQueryPushesSearchRangeSortAndLimit(t *testing.T) {
	limit := 25
	definition := &query.Definition{
		From: "runs",
		Filter: &query.Filter{
			Predicates: []query.Predicate{{Field: "started-at", GTE: "2026-01-01T00:00:00Z", LT: "2026-02-01T00:00:00Z"}},
			Search:     &query.Search{Fields: []string{"title"}, Query: "failed run"},
		},
		OrderBy: []query.OrderField{{Field: "started-at", Direction: "desc"}},
		Limit:   &limit,
	}
	plan := PlanQuery(
		"idx", "runs", definition,
		map[string]string{"started-at": "f_time", "title": "f_title"},
		map[string]string{"started-at": "NUMERIC", "title": "TEXT"},
	)
	command := strings.Join(plan.Command, " ")
	for _, expected := range []string{"FT.SEARCH idx", "@f_time:[1767225600000 (1769904000000]", "@f_title:failed run", "SORTBY f_time DESC", "LIMIT 0 25"} {
		if !strings.Contains(command, expected) {
			t.Fatalf("command %q does not contain %q", command, expected)
		}
	}
	if len(plan.Fallback) != 0 {
		t.Fatalf("unexpected fallback: %v", plan.Fallback)
	}
}

func TestPlanQueryPushesCompatibleAggregate(t *testing.T) {
	definition := &query.Definition{
		From: "runs",
		Aggregate: &query.Aggregate{
			By: []string{"conclusion"},
			Values: []query.AggregateValue{
				{Field: "id", As: "runs", Reducer: "count"},
				{Field: "duration", As: "average", Reducer: "mean"},
			},
		},
	}
	plan := PlanQuery(
		"idx", "runs", definition,
		map[string]string{"conclusion": "f_conclusion", "id": "f_id", "duration": "f_duration"},
		map[string]string{"conclusion": "TAG", "id": "TAG", "duration": "NUMERIC"},
	)
	command := strings.Join(plan.Command, " ")
	if !plan.Aggregate || !strings.Contains(command, "FT.AGGREGATE idx * GROUPBY 1 @f_conclusion") ||
		!strings.Contains(command, "REDUCE COUNT 0 AS runs") ||
		!strings.Contains(command, "REDUCE AVG 1 @f_duration AS average") {
		t.Fatalf("unexpected aggregate plan: %#v", plan)
	}
}
