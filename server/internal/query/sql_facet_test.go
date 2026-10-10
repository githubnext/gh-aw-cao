package query

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func facetTestResolver(string) (SQLRelation, error) {
	return SQLRelation{
		SQL: `(VALUES
			(1, 'copilot'::text, 'one'::text, 'worker'::text, 2::numeric),
			(2, 'claude', 'two', 'worker', 9),
			(3, 'copilot', 'one', 'worker', 3),
			(4, 'claude', 'two', 'review', 7),
			(5, NULL, 'three', 'worker', 4),
			(6, NULL, 'three', 'review', 6)
		) AS facts(ordinal, engine, repository, workflow, aic)`,
		Order: "ordinal",
		Columns: map[string]SQLColumn{
			"engine":     {Expression: "engine", Presence: "TRUE", Kind: SQLText},
			"repository": {Expression: "repository", Presence: "TRUE", Kind: SQLText},
			"workflow":   {Expression: "workflow", Presence: "TRUE", Kind: SQLText},
			"aic":        {Expression: "aic", Presence: "TRUE", Kind: SQLNumber},
		},
	}, nil
}

func TestCompileSQLFacet(t *testing.T) {
	plan, err := CompileSQL([]Definition{{
		Name: "facets", From: "facts", Facet: &Facet{Row: "engine", Column: "repository", As: "facet-rows"},
	}}, []string{"facets"}, facetTestResolver)
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"jsonb_agg(payload ORDER BY ordinal)", "PARTITION BY row_value", "dense_rank()", "GROUP BY field,row_value,column_value"} {
		if !strings.Contains(plan.CTEs, fragment) {
			t.Fatalf("missing SQL facet lowering %q", fragment)
		}
	}
	if len(plan.Outputs["facets"].Columns) != 6 {
		t.Fatal("facet output must contain only axis categories, positions and ordered rows")
	}
}

func TestSQLFacetRejectsInvalidDeclarations(t *testing.T) {
	for _, facet := range []*Facet{
		{}, {Field: "engine"}, {Field: "engine", Row: "repository", As: "rows"},
		{Field: "missing", As: "rows"},
		{Field: "engine", As: "facet-field"}, {Field: "engine", As: " "},
	} {
		if _, err := CompileSQL([]Definition{{Name: "bad", From: "facts", Facet: facet}}, []string{"bad"}, facetTestResolver); err == nil {
			t.Fatalf("invalid facet admitted: %+v", facet)
		}
	}
}

func TestSQLFacetOrderedPayloadInPostgres(t *testing.T) {
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
	limit := 3
	for _, testcase := range []struct {
		name  string
		facet Facet
		want  []map[string]any
	}{
		{"field", Facet{Field: "engine", As: "facet-rows"}, []map[string]any{
			{"facet-field": "claude", "facet-row": nil, "facet-column": nil, "facet-row-index": float64(0), "facet-column-index": float64(0),
				"facet-rows": []any{map[string]any{"engine": "claude", "workflow": "review", "sum-aic": float64(7)}, map[string]any{"engine": "claude", "workflow": "worker", "sum-aic": float64(9)}}},
			{"facet-field": "copilot", "facet-row": nil, "facet-column": nil, "facet-row-index": float64(0), "facet-column-index": float64(0),
				"facet-rows": []any{map[string]any{"engine": "copilot", "workflow": "worker", "sum-aic": float64(5)}}},
		}},
		{"row", Facet{Row: "engine", As: "facet-rows"}, []map[string]any{
			{"facet-field": nil, "facet-row": "claude", "facet-column": nil, "facet-row-index": float64(0), "facet-column-index": float64(0),
				"facet-rows": []any{map[string]any{"engine": "claude", "workflow": "review", "sum-aic": float64(7)}, map[string]any{"engine": "claude", "workflow": "worker", "sum-aic": float64(9)}}},
			{"facet-field": nil, "facet-row": "copilot", "facet-column": nil, "facet-row-index": float64(1), "facet-column-index": float64(0),
				"facet-rows": []any{map[string]any{"engine": "copilot", "workflow": "worker", "sum-aic": float64(5)}}},
		}},
	} {
		t.Run(testcase.name, func(t *testing.T) {
			definitions := []Definition{
				{Name: "prepared", From: "facts", Filter: &Filter{Predicates: []Predicate{{Field: "repository", In: []any{"one", "two"}}}},
					Aggregate: &Aggregate{By: []string{"engine", "workflow"}, Values: []AggregateValue{{Field: "aic", As: "sum-aic", Reducer: "sum"}}},
					OrderBy:   []OrderField{{Field: "engine"}, {Field: "workflow"}}, Limit: &limit},
				{Name: "panels", From: "prepared", Facet: &testcase.facet},
			}
			plan, err := CompileSQL(definitions, []string{"panels"}, facetTestResolver)
			if err != nil {
				t.Fatal(err)
			}
			statement, args, fields, err := plan.OutputStatement("panels", 0, 64)
			if err != nil {
				t.Fatal(err)
			}
			rows, err := db.QueryContext(t.Context(), statement, args...)
			if err != nil {
				t.Fatalf("facet SQL execution: %v\n%s", err, statement)
			}
			defer func() { _ = rows.Close() }()
			got := []map[string]any{}
			for rows.Next() {
				values := make([]any, len(fields))
				present := make([]bool, len(fields))
				dest := make([]any, len(fields)*2)
				for index := range fields {
					dest[index*2], dest[index*2+1] = &values[index], &present[index]
				}
				if err := rows.Scan(dest...); err != nil {
					t.Fatal(err)
				}
				row := map[string]any{}
				for index, field := range fields {
					if !present[index] {
						t.Fatalf("missing required facet output field %s", field)
					}
					var value any
					if values[index] != nil {
						var encoded []byte
						switch raw := values[index].(type) {
						case []byte:
							encoded = raw
						case string:
							encoded = []byte(raw)
						case int64:
							value = float64(raw)
						default:
							t.Fatalf("unexpected facet SQL value type %T", raw)
						}
						if len(encoded) > 0 {
							if err := json.Unmarshal(encoded, &value); err != nil {
								t.Fatal(err)
							}
						}
					}
					row[field] = value
				}
				got = append(got, row)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, testcase.want) {
				t.Fatalf("facet payload = %#v, want %#v", got, testcase.want)
			}
		})
	}
}
