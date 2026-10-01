package postgresx

import (
	"reflect"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestCompileUsesBoundSnapshotAndSourceValues(t *testing.T) {
	snapshotID := "snapshot' OR true; DROP TABLE cao_projection_rows; --"
	sourceName := "runs' OR true --"
	plan, err := Compile(query.Definition{
		Name: "all-runs",
		From: sourceName,
	}, snapshotID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.SQL, snapshotID) || strings.Contains(plan.SQL, sourceName) {
		t.Fatalf("query values were interpolated into SQL: %s", plan.SQL)
	}
	if !strings.Contains(plan.SQL, "$1") || !strings.Contains(plan.SQL, "$2") || !strings.Contains(plan.SQL, "$3") {
		t.Fatalf("SQL is missing expected placeholders: %s", plan.SQL)
	}
	if !reflect.DeepEqual(plan.Args, []any{snapshotID, sourceName, query.MaxInputRows + 1}) {
		t.Fatalf("query arguments = %#v", plan.Args)
	}
}

func TestCompileDeclinesPlansOutsideExactSourcePreservation(t *testing.T) {
	limit := 10
	tests := []struct {
		name       string
		definition query.Definition
	}{
		{
			name: "filter",
			definition: query.Definition{
				Name: "filtered", From: "runs",
				Filter: &query.Filter{Predicates: []query.Predicate{{Field: "status", Equals: "success"}}},
			},
		},
		{
			name: "closed shape",
			definition: query.Definition{
				Name: "selected", From: "runs",
				Select: []query.SelectedField{{Field: "status"}},
			},
		},
		{
			name: "limit",
			definition: query.Definition{
				Name: "limited", From: "runs", Limit: &limit,
			},
		},
		{
			name: "join",
			definition: query.Definition{
				Name: "joined", From: "runs",
				Joins: []query.Join{{Source: "repositories", On: []query.JoinKey{{Left: "repository", Right: "id"}}}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Compile(test.definition, "snapshot"); err != ErrUnsupportedPlan {
				t.Fatalf("Compile error = %v, want ErrUnsupportedPlan", err)
			}
		})
	}
}
