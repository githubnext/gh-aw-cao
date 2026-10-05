package query

import (
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

type windowParityFixture struct {
	Rows []struct {
		ID string `json:"id"`
	} `json:"rows"`
	Cases []struct {
		Name     string        `json:"name"`
		Window   []WindowField `json:"window"`
		Fields   []string      `json:"fields"`
		Expected [][]*float64  `json:"expected"`
	} `json:"cases"`
}

func readWindowParityFixture(t *testing.T) (windowParityFixture, json.RawMessage) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "window-parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture windowParityFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	var source struct {
		Rows json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Rows) == 0 || len(fixture.Cases) == 0 {
		t.Fatal("shared window parity fixture must contain rows and cases")
	}
	return fixture, source.Rows
}

func compileWindowParityCase(t *testing.T, window []WindowField, rows json.RawMessage) SQLPlan {
	t.Helper()
	resolver := func(string) (SQLRelation, error) {
		return SQLRelation{
			SQL: `(SELECT source.ordinal, record.id, record.workflow, record.value, record."observed-at"
				FROM jsonb_array_elements({}::jsonb) WITH ORDINALITY AS source(payload, ordinal)
				CROSS JOIN LATERAL jsonb_to_record(source.payload) AS record(
					id text, workflow text, value numeric, "observed-at" timestamptz)) AS observations`,
			Params: []any{string(rows)},
			Order:  "ordinal",
			Columns: map[string]SQLColumn{
				"id":          {Expression: "id", Presence: "TRUE", Kind: SQLText},
				"workflow":    {Expression: "workflow", Presence: "TRUE", Kind: SQLText},
				"value":       {Expression: "value", Presence: "TRUE", Kind: SQLNumber},
				"observed-at": {Expression: SQLIdentifier("observed-at"), Presence: "TRUE", Kind: SQLTimestamp},
			},
		}, nil
	}
	plan, err := CompileSQL([]Definition{{Name: "fixture", From: "observations", Window: window}},
		[]string{"fixture"}, resolver)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestSQLWindowSharedParityFixtureCompiles(t *testing.T) {
	fixture, rows := readWindowParityFixture(t)
	for _, testcase := range fixture.Cases {
		t.Run(testcase.Name, func(t *testing.T) {
			if len(testcase.Expected) != len(fixture.Rows) || len(testcase.Fields) != len(testcase.Window) {
				t.Fatal("fixture row count or output fields do not match the windows")
			}
			for index, expected := range testcase.Expected {
				if len(expected) != len(testcase.Fields) {
					t.Fatalf("fixture row %d has mismatched output width", index)
				}
			}
			plan := compileWindowParityCase(t, testcase.Window, rows)
			for _, field := range testcase.Fields {
				if plan.Outputs["fixture"].Columns[field].Kind != SQLNumber {
					t.Fatalf("missing numeric window output %q", field)
				}
			}
		})
	}
}

func runSQLWindowSharedParityFixtureInPostgres(t *testing.T, db *sql.DB, fixture windowParityFixture, source json.RawMessage) {
	for _, testcase := range fixture.Cases {
		t.Run(testcase.Name, func(t *testing.T) {
			plan := compileWindowParityCase(t, testcase.Window, source)
			statement, args, fields, err := plan.OutputStatement("fixture", 0, len(fixture.Rows))
			if err != nil {
				t.Fatal(err)
			}
			results, err := db.QueryContext(t.Context(), statement, args...)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = results.Close() }()
			observed := make(map[string]map[string]sql.NullString, len(fixture.Rows))
			for results.Next() {
				values := make([]sql.NullString, len(fields))
				present := make([]bool, len(fields))
				destinations := make([]any, 0, len(fields)*2)
				for index := range fields {
					destinations = append(destinations, &values[index], &present[index])
				}
				if err := results.Scan(destinations...); err != nil {
					t.Fatal(err)
				}
				current := make(map[string]sql.NullString, len(fields))
				for index, field := range fields {
					if !present[index] {
						t.Fatalf("SQL field %q is unexpectedly absent", field)
					}
					current[field] = values[index]
				}
				id := current["id"].String
				if id == "" || !current["id"].Valid || observed[id] != nil {
					t.Fatalf("missing or duplicate fixture row ID %q", id)
				}
				observed[id] = current
			}
			if err := results.Err(); err != nil {
				t.Fatal(err)
			}
			if len(observed) != len(fixture.Rows) {
				t.Fatalf("got %d rows, want %d", len(observed), len(fixture.Rows))
			}
			for index, row := range fixture.Rows {
				for column, field := range testcase.Fields {
					want := testcase.Expected[index][column]
					got := observed[row.ID][field]
					if want == nil {
						if got.Valid {
							t.Errorf("%s %s = %q, want null", row.ID, field, got.String)
						}
						continue
					}
					number, err := strconv.ParseFloat(got.String, 64)
					if !got.Valid || err != nil || math.Abs(number-*want) > 1e-9 {
						t.Errorf("%s %s = %q, want %v", row.ID, field, got.String, *want)
					}
				}
			}
		})
	}
}
