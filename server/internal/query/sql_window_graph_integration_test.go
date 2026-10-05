package query

import (
	"database/sql"
	"os"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func windowGraphDefinitions() []Definition {
	timestamp := "observed-at"
	frame := 2
	return []Definition{
		{Name: "bucket", From: "facts", Compute: []ComputedField{
			{As: "day", Function: "date-day", Args: []Argument{{Field: &timestamp}}},
		}},
		{Name: "daily", From: "bucket", Aggregate: &Aggregate{
			By:     []string{"workflow", "day"},
			Values: []AggregateValue{{Field: "value", As: "total", Reducer: "sum"}},
		}},
		{Name: "trend", From: "daily", Window: []WindowField{
			{Operation: "rolling", Field: "total", As: "moving", Frame: &frame,
				GroupBy: []string{"workflow"}, OrderBy: []OrderField{{Field: "day"}}},
			{Operation: "change", Field: "moving", As: "rate", Mode: "rate", TimeField: "day", Unit: "day",
				GroupBy: []string{"workflow"}, OrderBy: []OrderField{{Field: "day"}}},
		},
			Select: []SelectedField{{Field: "workflow"}, {Field: "day"}, {Field: "total"},
				{Field: "moving"}, {Field: "rate"}},
			OrderBy: []OrderField{{Field: "workflow"}, {Field: "day"}}},
	}
}

func windowGraphResolver(string) (SQLRelation, error) {
	return SQLRelation{
		SQL: `(VALUES
			(1, 'a'::text, '2026-01-01T02:00:00Z'::timestamptz, 1::numeric),
			(2, 'b', '2026-01-01T08:00:00Z', 10),
			(3, 'a', '2026-01-01T18:00:00Z', 2),
			(4, 'a', '2026-01-02T00:00:00Z', 4),
			(5, 'a', '2026-01-04T00:00:00Z', 6),
			(6, 'b', '2026-01-03T00:00:00Z', 30))
			AS facts(ordinal, workflow, observed_at, value)`,
		Order: "ordinal",
		Columns: map[string]SQLColumn{
			"workflow":    {Expression: "workflow", Presence: "TRUE", Kind: SQLText},
			"observed-at": {Expression: "observed_at", Presence: "TRUE", Kind: SQLTimestamp},
			"value":       {Expression: "value", Presence: "TRUE", Kind: SQLNumber},
		},
	}, nil
}

func TestSQLWindowCompleteQueryGraphCompiles(t *testing.T) {
	plan, err := CompileSQL(windowGraphDefinitions(), []string{"trend"}, windowGraphResolver)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Outputs["trend"].Columns) != 5 || len(plan.Steps) < 7 {
		t.Fatalf("incomplete SQL graph: %+v", plan)
	}
}

func TestSQLWindowCompleteQueryGraphInPostgres(t *testing.T) {
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
	plan, err := CompileSQL(windowGraphDefinitions(), []string{"trend"}, windowGraphResolver)
	if err != nil {
		t.Fatal(err)
	}
	statement, args, fields, err := plan.OutputStatement("trend", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(t.Context(), statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	type expectedRow struct {
		workflow, day string
		total, moving float64
		rate          *float64
	}
	rate := func(value float64) *float64 { return &value }
	want := []expectedRow{
		{"a", "2026-01-01", 3, 3, nil},
		{"a", "2026-01-02", 4, 3.5, rate(0.5)},
		{"a", "2026-01-04", 6, 5, rate(0.75)},
		{"b", "2026-01-01", 10, 10, nil},
		{"b", "2026-01-03", 30, 20, rate(5)},
	}
	index := 0
	for rows.Next() {
		values := make([]sql.NullString, len(fields))
		present := make([]bool, len(fields))
		destinations := make([]any, 0, len(fields)*2)
		for position := range fields {
			destinations = append(destinations, &values[position], &present[position])
		}
		if err := rows.Scan(destinations...); err != nil {
			t.Fatal(err)
		}
		if index >= len(want) {
			t.Fatal("SQL graph returned extra rows")
		}
		row := map[string]sql.NullString{}
		for position, field := range fields {
			if !present[position] {
				t.Fatalf("SQL graph field %q is missing", field)
			}
			row[field] = values[position]
		}
		expected := want[index]
		if row["workflow"].String != expected.workflow || row["day"].String != expected.day {
			t.Errorf("row %d bucket = %s/%s, want %s/%s", index,
				row["workflow"].String, row["day"].String, expected.workflow, expected.day)
		}
		for field, value := range map[string]*float64{
			"total": &expected.total, "moving": &expected.moving, "rate": expected.rate,
		} {
			got := row[field]
			if value == nil {
				if got.Valid {
					t.Errorf("row %d %s = %q, want null", index, field, got.String)
				}
				continue
			}
			number, err := strconv.ParseFloat(got.String, 64)
			if !got.Valid || err != nil || number != *value {
				t.Errorf("row %d %s = %q, want %v", index, field, got.String, *value)
			}
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if index != len(want) {
		t.Fatalf("SQL graph returned %d rows, want %d", index, len(want))
	}
}
