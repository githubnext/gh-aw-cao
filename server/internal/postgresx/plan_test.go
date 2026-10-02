package postgresx

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// TestSimplePlanAdmitsRawPassthroughAndOneFilteredStage confirms the two
// admitted shapes: a bare raw source, and a raw source followed by one
// filtering/selecting definition.
func TestSimplePlanAdmitsRawPassthroughAndOneFilteredStage(t *testing.T) {
	definitions := []query.Definition{
		{Name: "picked", From: "raw"},
	}
	raw, path, reason := simplePlan(definitions, []string{"picked"}, []string{"picked"})
	if reason != planRejectionReasonNone || raw != "raw" || len(path) != 1 {
		t.Fatalf("raw passthrough was not admitted: raw=%q path=%v reason=%s", raw, path, reason)
	}

	limit := 10
	definitions = []query.Definition{
		{Name: "alias", From: "raw"},
		{Name: "picked", From: "alias", Filter: &query.Filter{
			Predicates: []query.Predicate{{Field: "runId", Equals: "run-1"}},
		}, Limit: &limit},
	}
	raw, path, reason = simplePlan(definitions, []string{"picked"}, []string{"alias", "picked"})
	if reason != planRejectionReasonNone || raw != "raw" || len(path) != 2 {
		t.Fatalf("filtered second stage was not admitted: raw=%q path=%v reason=%s", raw, path, reason)
	}
}

// TestSimplePlanRejectsEachUnsupportedShape exercises every classification
// simplePlan can return for a declined request, so a request that falls back
// to the Go evaluator is diagnosable by reason without a Postgres instance.
func TestSimplePlanRejectsEachUnsupportedShape(t *testing.T) {
	limit := 5
	cases := []struct {
		name        string
		definitions []query.Definition
		requested   []string
		order       []string
		want        planRejectionReason
	}{
		{
			name:        "multiple requested sources",
			definitions: []query.Definition{{Name: "picked", From: "raw"}},
			requested:   []string{"picked", "other"},
			order:       []string{"picked"},
			want:        planRejectionReasonRequestShape,
		},
		{
			name:        "order does not end at requested",
			definitions: []query.Definition{{Name: "picked", From: "raw"}},
			requested:   []string{"picked"},
			order:       []string{"other"},
			want:        planRejectionReasonRequestShape,
		},
		{
			name: "raw source is itself derived",
			definitions: []query.Definition{
				{Name: "derived", From: "raw"},
				{Name: "picked", From: "derived"},
			},
			requested: []string{"picked"},
			order:     []string{"picked"},
			want:      planRejectionReasonDerivedRawSource,
		},
		{
			name: "unsupported join operator",
			definitions: []query.Definition{
				{Name: "picked", From: "raw", Joins: []query.Join{{Source: "other"}}},
			},
			requested: []string{"picked"},
			order:     []string{"picked"},
			want:      planRejectionReasonUnsupportedOperator,
		},
		{
			name: "intermediate stage shapes output",
			definitions: []query.Definition{
				{Name: "alias", From: "raw", Limit: &limit},
				{Name: "picked", From: "alias"},
			},
			requested: []string{"picked"},
			order:     []string{"alias", "picked"},
			want:      planRejectionReasonIntermediateShaping,
		},
		{
			name: "search predicate is unsupported",
			definitions: []query.Definition{
				{Name: "picked", From: "raw", Filter: &query.Filter{Search: &query.Search{Query: "x"}}},
			},
			requested: []string{"picked"},
			order:     []string{"picked"},
			want:      planRejectionReasonUnsupportedSearch,
		},
		{
			name: "predicate field is not whitelisted",
			definitions: []query.Definition{
				{Name: "picked", From: "raw", Filter: &query.Filter{
					Predicates: []query.Predicate{{Field: "status", Equals: "ok"}},
				}},
			},
			requested: []string{"picked"},
			order:     []string{"picked"},
			want:      planRejectionReasonUnsupportedPredicate,
		},
		{
			name: "predicate value is not an equals string",
			definitions: []query.Definition{
				{Name: "picked", From: "raw", Filter: &query.Filter{
					Predicates: []query.Predicate{{Field: "runId", In: []any{"a", "b"}}},
				}},
			},
			requested: []string{"picked"},
			order:     []string{"picked"},
			want:      planRejectionReasonUnsupportedPredicate,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, path, reason := simplePlan(tc.definitions, tc.requested, tc.order)
			if reason != tc.want {
				t.Fatalf("simplePlan() reason = %s, want %s", reason, tc.want)
			}
			if path != nil {
				t.Fatalf("expected a nil path on rejection, got %v", path)
			}
		})
	}
}
