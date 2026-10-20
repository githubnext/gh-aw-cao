package postgresx

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestSQLWindowFilteredJoinsUseSetBasedPlans(t *testing.T) {
	store, _ := nativeTestStore(t)
	definitions := []query.Definition{
		{Name: "ranked", From: "facts", Window: []query.WindowField{{
			Operation: "row-number", Field: "id", As: "position",
			GroupBy: []string{"id"}, OrderBy: []query.OrderField{{Field: "id"}},
		}}},
		{Name: "picked", From: "ranked", Filter: &query.Filter{
			Predicates: []query.Predicate{{Field: "position", Equals: 1}},
		}},
		{Name: "reranked", From: "picked", Window: []query.WindowField{{
			Operation: "row-number", Field: "id", As: "second-position",
			GroupBy: []string{"id"}, OrderBy: []query.OrderField{{Field: "id"}},
		}}},
		{Name: "selected", From: "reranked", Filter: &query.Filter{
			Predicates: []query.Predicate{{Field: "second-position", Equals: 1}},
		}},
		{Name: "joined", From: "selected", Joins: []query.Join{{
			Source: "selected", Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}},
			Fields: []query.SelectedField{{Field: "id", As: "matched"}},
		}}, Select: []query.SelectedField{{Field: "id"}, {Field: "matched"}}},
	}
	plan, err := query.CompileSQL(definitions, []string{"joined"}, func(string) (query.SQLRelation, error) {
		return query.SQLRelation{
			SQL:   "(SELECT n::text AS id, n AS ordinal FROM generate_series(1,2000) AS n) AS facts",
			Order: "ordinal",
			Columns: map[string]query.SQLColumn{
				"id": {Expression: "id", Presence: "TRUE", Kind: query.SQLText},
			},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	stats, statsArgs, err := plan.StatisticsStatement()
	if err != nil {
		t.Fatal(err)
	}
	output, outputArgs, _, err := plan.OutputStatement("joined", 0, query.MaxOutputRows)
	if err != nil {
		t.Fatal(err)
	}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
		tx := reader.(*readTransaction).tx
		for _, statement := range []struct {
			sql  string
			args []any
		}{{stats, statsArgs}, {output, outputArgs}} {
			var content []byte
			if err := tx.QueryRowContext(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+statement.sql, statement.args...).Scan(&content); err != nil {
				return err
			}
			type node struct {
				Type  string `json:"Node Type"`
				Plans []node
			}
			var explained []struct{ Plan node }
			if err := json.Unmarshal(content, &explained); err != nil {
				return err
			}
			var inspect func(node)
			inspect = func(plan node) {
				if plan.Type == "Nested Loop" {
					t.Fatal("window-filtered equijoin must not repeatedly scan its derived input")
				}
				for _, child := range plan.Plans {
					inspect(child)
				}
			}
			for _, entry := range explained {
				inspect(entry.Plan)
			}
		}
		rows, err := tx.QueryContext(ctx, output, outputArgs...)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		count := 0
		for rows.Next() {
			var id, matched string
			var idPresent, matchedPresent bool
			if err := rows.Scan(&id, &idPresent, &matched, &matchedPresent); err != nil {
				return err
			}
			if id != matched || !idPresent || !matchedPresent {
				t.Fatalf("set-based join changed matching: %s %s %t %t", id, matched, idPresent, matchedPresent)
			}
			count++
		}
		if count != 2000 {
			t.Fatalf("set-based join returned %d rows, want 2000", count)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
}
