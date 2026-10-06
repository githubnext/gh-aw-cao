package query

import (
	"strings"
	"testing"
)

func TestNeededCTEsFollowsTransitiveReferences(t *testing.T) {
	cteList := []string{
		`"q1" AS (SELECT 1)`,
		`"q2" AS (SELECT * FROM "q1")`,
		`"q3" AS (SELECT * FROM "q2")`,
		`"q4" AS (SELECT 1)`, // unreferenced by the starting fragment
	}
	needed := neededCTEs(cteList, []string{`SELECT * FROM "q3"`})
	if !needed[0] || !needed[1] || !needed[2] {
		t.Fatalf("expected the transitive chain q3<-q2<-q1 to be needed, got %+v", needed)
	}
	if needed[3] {
		t.Fatalf("expected an unreferenced CTE to be excluded, got %+v", needed)
	}
}

func TestNeededCTEsIgnoresSelfReference(t *testing.T) {
	// A CTE that references its own relation name (e.g. inside a comment or
	// a recursive-looking fragment) must not mark itself needed twice or
	// infinite-loop through visit.
	cteList := []string{`"q1" AS (SELECT * FROM "q1" WHERE false)`}
	needed := neededCTEs(cteList, []string{`SELECT 1`})
	if needed[0] {
		t.Fatalf("expected a fragment that never references q1 to leave it unneeded, got %+v", needed)
	}
}

func TestNeededCTEsEmptyFragmentsNeedNothing(t *testing.T) {
	cteList := []string{`"q1" AS (SELECT 1)`, `"q2" AS (SELECT * FROM "q1")`}
	needed := neededCTEs(cteList, nil)
	for index, isNeeded := range needed {
		if isNeeded {
			t.Fatalf("expected no CTE to be needed with no starting fragments, index %d: %+v", index, needed)
		}
	}
}

func TestScopedPrunesUnreferencedCTEs(t *testing.T) {
	definitions := []Definition{
		{Name: "selected", From: "facts"},
		{Name: "unused", From: "owners"},
		{Name: "totals", From: "selected", Aggregate: &Aggregate{By: []string{"owner"}, Values: []AggregateValue{{Field: "value", As: "total", Reducer: "sum"}}}},
	}
	plan, err := CompileSQL(definitions, []string{"totals", "unused"}, sqlTestResolver)
	if err != nil {
		t.Fatal(err)
	}
	totalsRelation, ok := plan.Outputs["totals"]
	if !ok {
		t.Fatal("expected a totals output relation")
	}
	scoped, _, rewritten := plan.Scoped(totalsRelation.SQL)
	if strings.Contains(scoped, `"`+relationName(plan, "unused")+`"`) {
		t.Fatalf("expected the unreferenced relation to be pruned from the scoped CTEs: %s", scoped)
	}
	if len(rewritten) != 1 {
		t.Fatalf("expected one rewritten fragment, got %d", len(rewritten))
	}
}

// relationName returns the "qN" relation name the compiler assigned to a
// named output, by locating it in plan.CTEList. Test helper only.
func relationName(plan SQLPlan, name string) string {
	relation, ok := plan.Outputs[name]
	if !ok {
		return ""
	}
	match := sqlRelationName.FindString(relation.SQL)
	return strings.Trim(match, `"`)
}

func TestScopedNoCTEsReturnsFragmentsUnchanged(t *testing.T) {
	plan := SQLPlan{CTEs: "", CTEList: nil, Args: []any{"a"}}
	scoped, args, rewritten := plan.Scoped("SELECT 1", "SELECT 2")
	if scoped != "" || len(args) != 1 || args[0] != "a" || len(rewritten) != 2 ||
		rewritten[0] != "SELECT 1" || rewritten[1] != "SELECT 2" {
		t.Fatalf("expected fragments to pass through unchanged when there are no CTEs, got scoped=%q args=%+v rewritten=%+v", scoped, args, rewritten)
	}
}
