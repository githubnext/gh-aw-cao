package postgresx

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestNativeEntityFilterUsesBoundValuesAndWhitelistedIdentifiers(t *testing.T) {
	namespace := `tenant' OR TRUE --`
	predicate := `run' OR TRUE --`
	reader := &readTransaction{store: &Store{namespace: namespace}}
	plan, err := query.CompileSQL([]query.Definition{{Name: "picked", From: "$tools",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "runId", Equals: predicate}}}}}, []string{"picked"}, reader.entitySQLSource)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.CTEs, namespace) || strings.Contains(plan.CTEs, predicate) {
		t.Fatal("SQL interpolated untrusted values")
	}
	found := false
	for _, value := range plan.Args {
		if value == predicate {
			found = true
		}
	}
	if !found {
		t.Fatal("predicate was not bound")
	}
}
