package query

import (
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
		{"link", []Argument{{Value: "https://example.com"}, {Value: "example"}}, `{"href": "https://example.com", "label": "example"}`},
		{"failure-streak-point", []Argument{field("observed"), field("run"), field("failed")}, "[1790186400000, \"r1\", true]"},
		{"calendar-week-point", []Argument{field("observed"), {Value: "2026-09-24T00:00:00Z"}, {Value: "success"}}, "[1790186400000, 1790208000000, true]"},
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
			var result string
			var present bool
			if err := db.QueryRowContext(t.Context(), statement, args...).Scan(&result, &present); err != nil {
				t.Fatalf("native function %s failed: %v", testcase.name, err)
			}
			if result != testcase.want || !present {
				t.Fatalf("native function %s = %q, want %q", testcase.name, result, testcase.want)
			}
		})
	}
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
