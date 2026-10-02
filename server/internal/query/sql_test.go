package query

import (
	"errors"
	"strings"
	"testing"
)

func sqlTestResolver(name string) (SQLRelation, error) {
	if name != "facts" && name != "owners" {
		return SQLRelation{}, errors.New("unregistered SQL source")
	}
	return SQLRelation{
		SQL:    "(SELECT * FROM " + SQLIdentifier(name) + " WHERE namespace = {}) AS source",
		Params: []any{"tenant"},
		Order:  "ordinal",
		Columns: map[string]SQLColumn{
			"id":    {Expression: "id", Presence: "TRUE", Kind: SQLText},
			"owner": {Expression: "owner", Presence: "TRUE", Kind: SQLText},
			"value": {Expression: "value", Presence: "TRUE", Kind: SQLNumber},
		},
	}, nil
}

func TestCompileRelationalSQLDAG(t *testing.T) {
	valueField := "value"
	definitions := []Definition{
		{Name: "selected", From: "facts", Filter: &Filter{Predicates: []Predicate{{Field: "owner", Equals: `owner' OR TRUE --`}}},
			Compute: []ComputedField{{As: "double", Function: "product", Args: []Argument{{Field: &valueField}, {Value: 2}}}}},
		{Name: "totals", From: "selected", Aggregate: &Aggregate{By: []string{"owner"}, Values: []AggregateValue{{Field: "double", As: "total", Reducer: "sum"}}},
			Select: []SelectedField{{Field: "owner"}, {Field: "total"}}, OrderBy: []OrderField{{Field: "total", Direction: "desc"}}},
	}
	plan, err := CompileSQL(definitions, []string{"totals"}, sqlTestResolver)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.CTEs, `owner' OR TRUE --`) || !strings.Contains(plan.CTEs, "GROUP BY") ||
		!strings.Contains(plan.CTEs, "MATERIALIZED") || plan.Outputs["totals"].Columns["total"].Kind != SQLNumber {
		t.Fatalf("unexpected SQL plan: %+v", plan)
	}
	if len(plan.Args) != 3 || plan.Args[0] != "tenant" || plan.Args[1] != `owner' OR TRUE --` || plan.Args[2] != 2 {
		t.Fatalf("unbound or reordered source/query parameters: %#v", plan.Args)
	}
	for _, step := range plan.Steps {
		if step.Operation == "filter" && step.Weight != 1 {
			t.Fatal("filter must charge unfiltered input")
		}
	}
	statement, args, _, err := plan.OutputStatement("totals", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(statement, "AS NOT MATERIALIZED") || !strings.Contains(statement, "AS MATERIALIZED") {
		t.Fatal("output must materialize intermediate relations to avoid repeated SQL evaluation")
	}
	if len(args) != 5 || args[0] != "tenant" || args[1] != `owner' OR TRUE --` || args[2] != 2 || args[3] != 100 || args[4] != 0 {
		t.Fatalf("output parameters were not preserved: %#v", args)
	}
}

func TestCompileSQLJoinsAndUnions(t *testing.T) {
	definitions := []Definition{
		{Name: "combined", From: "facts", Union: []string{"owners"}},
		{Name: "joined", From: "combined", Joins: []Join{{Source: "owners", Type: "left",
			On: []JoinKey{{Left: "owner", Right: "id"}}, Fields: []SelectedField{{Field: "value", As: "owner-value"}}}}},
	}
	plan, err := CompileSQL(definitions, []string{"joined"}, sqlTestResolver)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.CTEs, "UNION ALL") || !strings.Contains(plan.CTEs, "LEFT JOIN") ||
		!strings.Contains(plan.CTEs, "trim(") || len(plan.JoinKeys) != 1 ||
		!strings.Contains(plan.JoinKeys[0], "HAVING count(*) > 1") {
		t.Fatalf("bounded join/ordered union contract is missing: %+v", plan)
	}
	if plan.Outputs["joined"].Columns["owner-value"].Kind != SQLNumber {
		t.Fatal("join must preserve the imported type")
	}
}

func TestSQLCompilationFailsClosed(t *testing.T) {
	for _, definition := range []Definition{
		{Name: "bad", From: "unregistered"},
		{Name: "bad", From: "facts", Compute: []ComputedField{{As: "a", Function: "literal", Args: []Argument{{Parameter: "unresolved"}}}}},
		{Name: "bad", From: "facts", Joins: []Join{{Source: "owners", On: []JoinKey{{Left: "id", Right: "id"}}, Fields: []SelectedField{{Field: "value"}}}}},
	} {
		if _, err := CompileSQL([]Definition{definition}, []string{"bad"}, sqlTestResolver); err == nil {
			t.Fatalf("invalid SQL query was admitted: %+v", definition)
		}
	}
}

func TestSQLCompilationTreatsUndeclaredFieldsAsMissing(t *testing.T) {
	hostile := `id"; DROP TABLE facts; --`
	plan, err := CompileSQL([]Definition{{Name: "missing", From: "facts", Select: []SelectedField{{Field: hostile}}}},
		[]string{"missing"}, sqlTestResolver)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.CTEs, "DROP TABLE") || !strings.Contains(plan.CTEs, "NULL::text") {
		t.Fatalf("undeclared field must compile to a NULL column: %s", plan.CTEs)
	}
}

func TestSQLBindsNULStringsAsNonMatchingText(t *testing.T) {
	compiler := &sqlCompiler{}
	if placeholder := compiler.bind("a\x00b"); placeholder != "$1" {
		t.Fatalf("placeholder = %q", placeholder)
	}
	if got := compiler.args[0]; got != "a\uFFFDb" {
		t.Fatalf("bound value = %q", got)
	}
}
