package query

import (
	"database/sql"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func numericTextWindowPlan(t *testing.T) SQLPlan {
	t.Helper()
	resolver := func(string) (SQLRelation, error) {
		return SQLRelation{
			SQL: `(VALUES
				(1, 'a'::text, '10'::text, '2026-01-01T00:00:00Z'::timestamptz, 10::numeric),
				(2, 'a', '9', '2026-01-01T00:00:00Z', 9),
				(3, 'a', '11', '2026-01-01T00:00:01Z', 11),
				(4, 'b', '10', '2026-01-01T00:00:00Z', 10),
				(5, 'b', '9', '2026-01-01T00:00:00Z', 9))
				AS facts(ordinal, workflow, run, observed_at, value)`,
			Order: "ordinal",
			Columns: map[string]SQLColumn{
				"workflow":    {Expression: "workflow", Presence: "TRUE", Kind: SQLText},
				"run":         {Expression: "run", Presence: "TRUE", Kind: SQLText},
				"observed-at": {Expression: "observed_at", Presence: "TRUE", Kind: SQLTimestamp},
				"value":       {Expression: "value", Presence: "TRUE", Kind: SQLNumber},
			},
		}, nil
	}
	definition := Definition{Name: "ordered", From: "facts", Window: []WindowField{{
		Operation: "change", Field: "value", As: "delta", GroupBy: []string{"workflow"},
		OrderBy: []OrderField{{Field: "observed-at"}, {Field: "run"}},
	}}, Select: []SelectedField{{Field: "delta"}}}
	plan, err := CompileSQL([]Definition{definition}, []string{"ordered"}, resolver)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestSQLWindowNumericTextOrderCompiles(t *testing.T) {
	plan := numericTextWindowPlan(t)
	seen := false
	for _, step := range plan.Steps {
		seen = seen || step.Operation == "window-sort-key"
	}
	if !seen {
		t.Fatal("text window ordering omitted numeric partition check")
	}
}

func TestSQLWindowNumericTextOrderInPostgres(t *testing.T) {
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	defer func() { _ = db.Close() }()
	plan := numericTextWindowPlan(t)
	statement, args, fields, err := plan.OutputStatement("ordered", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0] != "delta" {
		t.Fatalf("internal sort key leaked into output: %v", fields)
	}
	rows, err := db.QueryContext(t.Context(), statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	want := []sql.NullString{{String: "1", Valid: true}, {}, {String: "1", Valid: true},
		{String: "1", Valid: true}, {}}
	index := 0
	for rows.Next() {
		if index >= len(want) {
			t.Fatal("unexpected extra row")
		}
		var value sql.NullString
		var present bool
		if err := rows.Scan(&value, &present); err != nil {
			t.Fatal(err)
		}
		if !present || value != want[index] {
			t.Errorf("row %d = %+v, present=%v; want %+v", index, value, present, want[index])
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if index != len(want) {
		t.Fatalf("got %d rows, want %d", index, len(want))
	}
}
