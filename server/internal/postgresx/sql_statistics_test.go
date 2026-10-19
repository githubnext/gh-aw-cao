package postgresx

import (
	"context"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestSQLStatisticsSharesRelationsWithJoinChecks(t *testing.T) {
	store, _ := nativeTestStore(t)
	conn, err := store.db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(t.Context(), "CREATE TEMP SEQUENCE stats_evaluations"); err != nil {
		t.Fatal(err)
	}
	definitions := []query.Definition{
		{Name: "owners", From: "facts"},
		{Name: "joined", From: "facts", Joins: []query.Join{
			{Source: "owners", Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}},
				Fields: []query.SelectedField{{Field: "id", As: "first-owner"}}},
			{Source: "owners", Type: "inner", On: []query.JoinKey{{Left: "id", Right: "id"}},
				Fields: []query.SelectedField{{Field: "id", As: "second-owner"}}},
		}},
	}
	plan, err := query.CompileSQL(definitions, []string{"joined"}, func(string) (query.SQLRelation, error) {
		return query.SQLRelation{
			SQL: `(SELECT n::text AS id, nextval('pg_temp.stats_evaluations') AS ordinal
				FROM generate_series(1,3) AS n) AS facts`,
			Order: "ordinal",
			Columns: map[string]query.SQLColumn{
				"id": {Expression: "id", Presence: "TRUE", Kind: query.SQLText},
			},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	statement, args, err := plan.StatisticsStatement()
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range plan.JoinKeys {
		if !strings.Contains(statement, check) {
			t.Fatal("join validation must share the accounting statement")
		}
	}
	rows, err := conn.QueryContext(t.Context(), statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	counted := map[string]bool{}
	for rows.Next() {
		var relation string
		var count, bytes int64
		var duplicate bool
		if err := rows.Scan(&relation, &count, &bytes, &duplicate); err != nil {
			t.Fatal(err)
		}
		if counted[relation] || count != 3 || bytes <= 0 || duplicate {
			t.Fatalf("invalid full-plan accounting: %s count=%d bytes=%d duplicate=%t", relation, count, bytes, duplicate)
		}
		counted[relation] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	for _, step := range plan.Steps {
		if !counted[step.Relation] {
			t.Fatalf("missing accounting for %s", step.Relation)
		}
	}
	var evaluations int
	if err := conn.QueryRowContext(t.Context(), "SELECT currval('pg_temp.stats_evaluations')").Scan(&evaluations); err != nil {
		t.Fatal(err)
	}
	if evaluations != 3 {
		t.Fatalf("shared source evaluated %d times, want exactly 3 rows once", evaluations)
	}
}

func TestSQLStatisticsRejectsDuplicateJoinKeys(t *testing.T) {
	store, _ := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, map[string][]model.Row{
		"$domains": {
			{"id": "one", "runId": "run", "domain": "same"},
			{"id": "two", "runId": "run", "domain": " same "},
			{"id": "blank", "runId": "run", "domain": ""},
			{"id": "whitespace", "runId": "run", "domain": " "},
		},
	})
	for _, tc := range []struct {
		name      string
		joinType  string
		emptyLeft bool
		rightIDs  []any
		many      bool
		wantRows  int
	}{
		{name: "left", joinType: "left"},
		{name: "inner", joinType: "inner"},
		{name: "empty-left", joinType: "left", emptyLeft: true},
		{name: "unique", joinType: "left", rightIDs: []any{"one"}, wantRows: 1},
		{name: "blank-keys", joinType: "left", rightIDs: []any{"blank", "whitespace"}, wantRows: 1},
		{name: "inner-many", joinType: "inner-many", many: true, wantRows: 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := query.Definition{Name: "input", From: "$runs"}
			if tc.emptyLeft {
				input.Filter = &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "absent"}}}
			}
			right := query.Definition{Name: "right", From: "$domains"}
			if tc.rightIDs != nil {
				right.Filter = &query.Filter{Predicates: []query.Predicate{{Field: "id", In: tc.rightIDs}}}
			}
			on := []query.JoinKey{{Left: "id", Right: "runId"}, {Left: "id", Right: "domain"}}
			if tc.many {
				on = on[:1]
			}
			definitions := []query.Definition{input, right, {
				Name: "joined", From: "input", Joins: []query.Join{
					{Source: "$workflows", Type: "left", On: []query.JoinKey{{Left: "workflowId", Right: "id"}},
						Fields: []query.SelectedField{{Field: "id", As: "matched-workflow"}}},
					{Source: "right", Type: tc.joinType, On: on,
						Fields: []query.SelectedField{{Field: "id", As: "matched-domain"}}},
				},
			}}
			err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
				sources, _, err := reader.ExecuteSQLPlanWithOptions(ctx, definitions, []string{"joined"}, SQLExecutionOptions{
					Pages: map[string]SQLPage{"joined": {Limit: 1}},
				})
				if err == nil && (len(sources["joined"].Rows) != 1 || sources["joined"].Metadata["total-row-count"] != tc.wantRows) {
					t.Errorf("invalid page cardinality: %+v", sources["joined"])
				}
				return err
			})
			if tc.wantRows == 0 {
				if err == nil || !strings.Contains(err.Error(), "joined source has more than one row per join key") {
					t.Fatalf("duplicate join keys must fail closed, including beyond the page: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
