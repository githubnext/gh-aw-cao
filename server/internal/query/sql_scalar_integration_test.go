package query

import (
	"database/sql"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestSQLComputedFunctionsInPostgres(t *testing.T) {
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
	field := func(name string) Argument { return Argument{Field: &name} }
	resolver := func(string) (SQLRelation, error) {
		return SQLRelation{
			SQL: `(VALUES (1, 'HTTP-test_name'::text, 12345.6789::numeric, '2026-09-23T18:00:00Z'::timestamptz, 'r1'::text, TRUE))
				AS facts(ordinal, label, value, observed, run, failed)`,
			Order: "ordinal",
			Columns: map[string]SQLColumn{
				"label":    {Expression: "label", Presence: "TRUE", Kind: SQLText},
				"value":    {Expression: "value", Presence: "TRUE", Kind: SQLNumber},
				"observed": {Expression: "observed", Presence: "TRUE", Kind: SQLTimestamp},
				"run":      {Expression: "run", Presence: "TRUE", Kind: SQLText},
				"failed":   {Expression: "failed", Presence: "TRUE", Kind: SQLBoolean},
			},
		}, nil
	}
	for _, testcase := range []struct {
		name string
		args []Argument
		want string
	}{
		{"title-case", []Argument{field("label")}, "HTTP Test Name"},
		{"url-encode", []Argument{{Value: "a/b:c !é"}}, "a%2Fb%3Ac%20!%C3%A9"},
		{"format-count", []Argument{field("value")}, "12,345.679"},
		{"format-percent", []Argument{{Value: 0.1234}}, "12.3%"},
		{"date-day", []Argument{field("observed")}, "2026-09-23"},
		{"timestamp", []Argument{field("observed")}, "1790186400000"},
		{"timestamp", []Argument{{Value: "1969-12-31T23:59:59.999Z"}}, "-1"},
		{"timestamp", []Argument{{Value: "2026-09-24T11:00:00.123+01:00"}}, "1790244000123"},
		{"timestamp", []Argument{{Value: "invalid"}}, "null"},
		{"timestamp", []Argument{{Value: "now"}}, "null"},
		{"timestamp", []Argument{{Value: "2026-02-30T00:00:00Z"}}, "null"},
		{"timestamp", []Argument{{Value: 123}}, "null"},
		{"iso-timestamp", []Argument{{Value: 1792166400123}}, "2026-10-16T16:00:00.123Z"},
		{"iso-timestamp", []Argument{{Value: -1}}, "1969-12-31T23:59:59.999Z"},
		{"iso-timestamp", []Argument{{Value: -62135596800000}}, "0001-01-01T00:00:00.000Z"},
		{"iso-timestamp", []Argument{{Value: 253402300799999}}, "9999-12-31T23:59:59.999Z"},
		{"iso-timestamp", []Argument{{Value: 253402300800000}}, "null"},
		{"sqrt", []Argument{{Value: 4}}, "2.000000000000000"},
		{"sqrt", []Argument{{Value: -1}}, "null"},
		{"link", []Argument{{Value: "https://example.com"}, {Value: "example"}}, `{"href": "https://example.com", "label": "example"}`},
		{"failure-streak-point", []Argument{field("observed"), field("run"), field("failed")}, "[1790186400000, \"r1\", true]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: "success"}}, "[1790186400000, 1790208000000, true]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: "failure"}}, "[1790186400000, 1790208000000, false]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: true}}, "[1790186400000, 1790208000000, true]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: false}}, "[1790186400000, 1790208000000, false]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, field("failed")}, "[1790186400000, 1790208000000, true]"},
	} {
		t.Run(testcase.name, func(t *testing.T) {
			definition := Definition{Name: "computed", From: "facts",
				Compute: []ComputedField{{As: "result", Function: testcase.name, Args: testcase.args}},
				Select:  []SelectedField{{Field: "result"}}}
			plan, err := CompileSQL([]Definition{definition}, []string{"computed"}, resolver)
			if err != nil {
				t.Fatal(err)
			}
			statement, args, _, err := plan.OutputStatement("computed", 0, 10)
			if err != nil {
				t.Fatal(err)
			}
			var result sql.NullString
			var present bool
			if err := db.QueryRowContext(t.Context(), statement, args...).Scan(&result, &present); err != nil {
				t.Fatalf("native function %s failed: %v", testcase.name, err)
			}
			if !result.Valid && testcase.want == "null" && present {
				return
			}
			if !result.Valid || result.String != testcase.want || !present {
				t.Fatalf("native function %s = %+v, want %q", testcase.name, result, testcase.want)
			}
		})
	}
	for _, quantile := range []struct {
		reducer string
		want    float64
	}{{"median", 15}, {"p75", 22.5}, {"p90", 27}, {"p95", 28.5}} {
		t.Run(quantile.reducer, func(t *testing.T) {
			definitions := []Definition{{Name: "quantiles", From: "facts",
				Aggregate: &Aggregate{Values: []AggregateValue{{Field: "value", As: "result", Reducer: quantile.reducer}}}}}
			plan, err := CompileSQL(definitions, []string{"quantiles"}, func(string) (SQLRelation, error) {
				return SQLRelation{SQL: "(VALUES (0::numeric), (10), (NULL), (20), (30)) AS facts(value)", Order: "value",
					Columns: map[string]SQLColumn{"value": {Expression: "value", Presence: "TRUE", Kind: SQLNumber}}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			statement, args, _, err := plan.OutputStatement("quantiles", 0, 10)
			if err != nil {
				t.Fatal(err)
			}
			var result float64
			var present bool
			if err := db.QueryRowContext(t.Context(), statement, args...).Scan(&result, &present); err != nil {
				t.Fatal(err)
			}
			if !present || result-quantile.want > 1e-12 || quantile.want-result > 1e-12 {
				t.Fatalf("quantile = %v, want %v", result, quantile.want)
			}
		})
	}
	t.Run("scalar predecessor and row number", func(t *testing.T) {
		definitions := []Definition{{Name: "ordered", From: "facts", Window: []WindowField{
			{Operation: "previous", Field: "label", As: "prior", GroupBy: []string{"owner"}, OrderBy: []OrderField{{Field: "ordinal"}}},
			{Operation: "row-number", Field: "label", As: "position", GroupBy: []string{"owner"}, OrderBy: []OrderField{{Field: "ordinal"}}},
		}, Select: []SelectedField{{Field: "prior"}, {Field: "position"}}}}
		plan, err := CompileSQL(definitions, []string{"ordered"}, func(string) (SQLRelation, error) {
			return SQLRelation{SQL: "(VALUES (1, 'a'::text, 'one'::text), (2, 'z', 'two'), (3, 'b', 'one')) AS facts(ordinal,label,owner)", Order: "ordinal",
				Columns: map[string]SQLColumn{
					"ordinal": {Expression: "ordinal", Presence: "TRUE", Kind: SQLNumber},
					"label":   {Expression: "label", Presence: "TRUE", Kind: SQLText},
					"owner":   {Expression: "owner", Presence: "TRUE", Kind: SQLText},
				}}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		statement, args, _, err := plan.OutputStatement("ordered", 0, 10)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := db.QueryContext(t.Context(), statement, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		count := 0
		for rows.Next() {
			var prior sql.NullString
			var position int
			var priorPresent, positionPresent bool
			if err := rows.Scan(&position, &positionPresent, &prior, &priorPresent); err != nil {
				t.Fatal(err)
			}
			want := count == 2
			if prior.Valid != want || (want && prior.String != "a") || position != []int{1, 1, 2}[count] || !positionPresent {
				t.Fatalf("row %d: prior=%+v, position=%d", count, prior, position)
			}
			count++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if count != 3 {
			t.Fatalf("rows = %d", count)
		}
	})
	for _, reducer := range []string{"calendar-week-rhythm", "latest-failure-streak"} {
		t.Run(reducer, func(t *testing.T) {
			function := "failure-streak-point"
			args := []Argument{field("observed"), field("run"), field("failed")}
			if reducer == "calendar-week-rhythm" {
				function = "calendar-week-point"
				args = []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: "success"}}
			}
			definition := Definition{Name: "summary", From: "facts",
				Compute:   []ComputedField{{As: "point", Function: function, Args: args}},
				Aggregate: &Aggregate{Values: []AggregateValue{{Field: "point", As: "summary", Reducer: reducer}}}}
			plan, err := CompileSQL([]Definition{definition}, []string{"summary"}, resolver)
			if err != nil {
				t.Fatal(err)
			}
			statement, values, _, err := plan.OutputStatement("summary", 0, 10)
			if err != nil {
				t.Fatal(err)
			}
			var result string
			var present bool
			if err := db.QueryRowContext(t.Context(), statement, values...).Scan(&result, &present); err != nil {
				t.Fatalf("native reducer %s failed: %v", reducer, err)
			}
			if reducer == "latest-failure-streak" {
				if result != "1" {
					t.Fatalf("streak = %s", result)
				}
				return
			}
			var decoded struct {
				Days []struct {
					Label, Date       string
					Current, Previous int
					Reached           bool
				}
			}
			if err := json.Unmarshal([]byte(result), &decoded); err != nil {
				t.Fatal(err)
			}
			if len(decoded.Days) != 7 || decoded.Days[2].Current != 1 || decoded.Days[4].Reached {
				t.Fatalf("invalid native calendar rhythm: %+v", decoded)
			}
		})
	}
}
