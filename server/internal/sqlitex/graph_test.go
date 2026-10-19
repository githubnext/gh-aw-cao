package sqlitex

import (
	"fmt"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestSharedMaterializedDependenciesDoNotConsumeDepthTwice(t *testing.T) {
	store, _ := seedStore(t)
	putRecord(t, t.Context(), store, "repositories", "one", model.Row{"id": "one"})
	defs := make([]query.Definition, 0, query.MaxDependencyDepth+3)
	input := "$repositories"
	for i := 0; i < query.MaxDependencyDepth-1; i++ {
		name := fmt.Sprintf("shared-%d", i)
		defs = append(defs, query.Definition{Name: name, From: input})
		input = name
	}
	shared := input
	for i := 0; i < 3; i++ {
		name := fmt.Sprintf("branch-%d", i)
		defs = append(defs, query.Definition{Name: name, From: input})
		input = name
	}
	defs = append(defs, query.Definition{Name: "root", From: shared, Joins: []query.Join{{
		Source: input, Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}},
		Fields: []query.SelectedField{{Field: "id", As: "joined"}},
	}}})
	sources, metrics, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"root"})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, sources["root"].Rows, []model.Row{{"id": "one", "joined": "one"}})
	if metrics.DependencyDepth != query.MaxDependencyDepth || metrics.QueryCount != len(defs) {
		t.Fatalf("materialized graph metrics: %#v", metrics)
	}
}

func TestUnmaterializedDependencyJoinPathRemainsBounded(t *testing.T) {
	store, _ := seedStore(t)
	defs := make([]query.Definition, 0, 5)
	input := "$repositories"
	for level := 0; level < 5; level++ {
		joins := make([]query.Join, query.MaxJoins)
		for i := range joins {
			joins[i] = query.Join{
				Source: "$runs", Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}},
				Fields: []query.SelectedField{{Field: "id", As: fmt.Sprintf("join-%d", i)}},
			}
		}
		name := fmt.Sprintf("joins-%d", level)
		defs = append(defs, query.Definition{Name: name, From: input, Joins: joins})
		input = name
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"joins-3"}); err != nil {
		t.Fatalf("uncached dependency path at the sixteen-join boundary was rejected: %v", err)
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{input}); err == nil {
		t.Fatal("uncached dependency path exceeding sixteen joins was accepted")
	}
}

func TestSharedMaterializedDependenciesDoNotConsumeJoinsTwice(t *testing.T) {
	store, _ := seedStore(t)
	putRecord(t, t.Context(), store, "repositories", "one", model.Row{"id": "one"})
	makeJoins := func(source string) []query.Join {
		joins := make([]query.Join, query.MaxJoins)
		for i := range joins {
			joins[i] = query.Join{
				Source: source, Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}},
				Fields: []query.SelectedField{{Field: "id", As: fmt.Sprintf("joined-%d", i)}},
			}
		}
		return joins
	}
	defs := make([]query.Definition, 0, 7)
	input := "$repositories"
	for i := 0; i < 3; i++ {
		name := fmt.Sprintf("shared-%d", i)
		defs = append(defs, query.Definition{Name: name, From: input, Joins: makeJoins("$repositories")})
		input = name
	}
	shared := input
	for i := 0; i < 3; i++ {
		name := fmt.Sprintf("branch-%d", i)
		defs = append(defs, query.Definition{Name: name, From: input, Joins: makeJoins("$repositories")})
		input = name
	}
	defs = append(defs, query.Definition{Name: "root", From: shared, Joins: makeJoins(input)})
	sources, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"root"})
	if err != nil {
		t.Fatal(err)
	}
	if rows := sources["root"].Rows; len(rows) != 1 || rows[0]["id"] != "one" || rows[0]["joined-3"] != "one" {
		t.Fatalf("materialized shared-join result: %#v", rows)
	}
}
