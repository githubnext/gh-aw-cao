package query

import (
	"fmt"
	"testing"
)

func TestDependencyPlanOrdersAndMeasuresDepth(t *testing.T) {
	definitions := []Definition{
		{Name: "base", From: "facts"},
		{Name: "middle", From: "base", Joins: []Join{{Source: "facts", On: []JoinKey{{Left: "id", Right: "id"}}}}},
		{Name: "top", From: "middle"},
	}
	order, maxDepth, maxJoinDepth, err := dependencyPlan(definitions, []string{"top"})
	if err != nil {
		t.Fatalf("dependencyPlan returned error: %v", err)
	}
	if len(order) != 3 || order[0] != "base" || order[1] != "middle" || order[2] != "top" {
		t.Fatalf("unexpected dependency order: %v", order)
	}
	// base=1, middle=max(base+1, facts-not-a-query)=2 plus its own join, top=middle+1=3.
	if maxDepth != 3 {
		t.Fatalf("maxDepth = %d, want 3", maxDepth)
	}
	if maxJoinDepth != 1 {
		t.Fatalf("maxJoinDepth = %d, want 1 (only middle declares a join)", maxJoinDepth)
	}
}

func TestDependencyPlanRejectsExcessiveDepth(t *testing.T) {
	definitions := make([]Definition, 0, MaxDependencyDepth+2)
	definitions = append(definitions, Definition{Name: "step0", From: "facts"})
	for i := 1; i <= MaxDependencyDepth+1; i++ {
		definitions = append(definitions, Definition{
			Name: namedStep(i),
			From: namedStep(i - 1),
		})
	}
	last := namedStep(MaxDependencyDepth + 1)
	if _, _, _, err := dependencyPlan(definitions, []string{last}); err == nil {
		t.Fatal("dependency chain beyond MaxDependencyDepth was accepted")
	}
}

func namedStep(i int) string {
	return fmt.Sprintf("step%d", i)
}

func TestComputeDependencyDepthsIgnoresNonQueryInputs(t *testing.T) {
	index := map[string]Definition{
		"derived": {Name: "derived", From: "raw_table"},
	}
	maxDepth, maxJoinDepth := computeDependencyDepths([]string{"derived"}, index)
	if maxDepth != 1 || maxJoinDepth != 0 {
		t.Fatalf("maxDepth=%d maxJoinDepth=%d, want 1 and 0 for a single leaf query", maxDepth, maxJoinDepth)
	}
}
