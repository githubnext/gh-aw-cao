package query

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestSQLWindowSharedParityFixtureInPostgres(t *testing.T) {
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is unset")
	}
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
	if len(fixture.Rows) == 0 || len(fixture.Cases) != 3 {
		t.Fatalf("expected 3 shared parity cases and source rows, got %d cases and %d rows",
			len(fixture.Cases), len(fixture.Rows))
	}
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	defer func() { _ = db.Close() }()
	runSQLWindowSharedParityFixtureInPostgres(t, db, fixture, source.Rows)
}

func TestSQLWindowsInPostgres(t *testing.T) {
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

	resolver := func(string) (SQLRelation, error) {
		return SQLRelation{
			SQL: `(VALUES
				(1, 'a'::text, 10::numeric, '2026-09-01'::text),
				(2, 'b', 100, '2026-09-01'),
				(3, 'a', 20, '2026-09-02'),
				(4, 'a', NULL::numeric, '2026-09-03'),
				(5, 'b', 200, '2026-09-02'),
				(6, 'a', 40, '2026-09-05'),
				(7, 'a', 80, 'not a date'),
				(8, 'a', 90, '2026-02-30'))
				AS observations(ordinal, owner, amount, day)`,
			Order: "ordinal",
			Columns: map[string]SQLColumn{
				"ordinal": {Expression: "ordinal", Presence: "TRUE", Kind: SQLNumber},
				"owner":   {Expression: "owner", Presence: "TRUE", Kind: SQLText},
				"amount":  {Expression: "amount", Presence: "TRUE", Kind: SQLNumber},
				"day":     {Expression: "day", Presence: "TRUE", Kind: SQLText},
			},
		}, nil
	}
	frame := 3
	definition := Definition{Name: "trend", From: "observations", Window: []WindowField{
		{Operation: "rolling", Field: "amount", As: "trailing", Frame: &frame, Reducer: "sum",
			OrderBy: []OrderField{{Field: "ordinal"}}, GroupBy: []string{"owner"}},
		{Operation: "rolling", Field: "amount", As: "centered", Frame: &frame,
			Alignment: "centered", OrderBy: []OrderField{{Field: "ordinal"}}, GroupBy: []string{"owner"}},
		{Operation: "change", Field: "amount", As: "percent", Mode: "percentage",
			OrderBy: []OrderField{{Field: "ordinal"}}, GroupBy: []string{"owner"}},
		{Operation: "change", Field: "amount", As: "rate", Mode: "rate", TimeField: "day", Unit: "day",
			OrderBy: []OrderField{{Field: "ordinal"}}, GroupBy: []string{"owner"}},
		{Operation: "change", Field: "trailing", As: "trailing-delta",
			OrderBy: []OrderField{{Field: "ordinal"}}, GroupBy: []string{"owner"}},
	}, Select: []SelectedField{{Field: "ordinal"}, {Field: "trailing"}, {Field: "centered"},
		{Field: "percent"}, {Field: "rate"}, {Field: "trailing-delta"}}}
	plan, err := CompileSQL([]Definition{definition}, []string{"trend"}, resolver)
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
	observed := map[string]map[string]sql.NullString{}
	for rows.Next() {
		values := make([]sql.NullString, len(fields))
		present := make([]bool, len(fields))
		targets := make([]any, 0, len(fields)*2)
		for index := range fields {
			targets = append(targets, &values[index], &present[index])
		}
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		byField := map[string]sql.NullString{}
		for index, field := range fields {
			if !present[index] {
				t.Fatalf("%s missing at row %v", field, values)
			}
			byField[field] = values[index]
		}
		observed[byField["ordinal"].String] = byField
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := map[string]map[string]string{
		"1": {"trailing": "10", "centered": "", "percent": "", "rate": "", "trailing-delta": ""},
		"2": {"trailing": "100", "centered": "", "percent": "", "rate": "", "trailing-delta": ""},
		"3": {"trailing": "30", "centered": "15", "percent": "100", "rate": "10", "trailing-delta": "20"},
		"4": {"trailing": "30", "centered": "30", "percent": "", "rate": "", "trailing-delta": "0"},
		"5": {"trailing": "300", "centered": "", "percent": "100", "rate": "100", "trailing-delta": "200"},
		"6": {"trailing": "60", "centered": "60", "percent": "", "rate": "", "trailing-delta": "30"},
		"7": {"trailing": "120", "centered": "70", "percent": "100", "rate": "", "trailing-delta": "60"},
		"8": {"trailing": "210", "centered": "", "percent": "12.5", "rate": "", "trailing-delta": "90"},
	}
	if len(observed) != len(want) {
		t.Fatalf("observations = %v", observed)
	}
	for ordinal, expected := range want {
		for field, number := range expected {
			got := observed[ordinal][field]
			if number == "" {
				if got.Valid {
					t.Errorf("row %s %s = %s, want null", ordinal, field, got.String)
				}
			} else {
				normalized := got.String
				if strings.Contains(normalized, ".") {
					normalized = strings.TrimRight(strings.TrimRight(normalized, "0"), ".")
				}
				if !got.Valid || normalized != number {
					t.Errorf("row %s %s = %+v, want %s", ordinal, field, got, number)
				}
			}
		}
	}
}

func TestSQLWindowStableOrderAndTypedTimestamp(t *testing.T) {
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
	resolver := func(string) (SQLRelation, error) {
		return SQLRelation{
			SQL: `(VALUES (1, 'a'::text, 0::numeric, '2026-01-01T00:00:00Z'::timestamptz),
				(2, 'a', 10, '2026-01-01T00:30:00Z'),
				(3, 'a', 20, '2026-01-01T01:00:00Z'))
				AS events(ordinal, owner, amount, at)`,
			Order: "ordinal",
			Columns: map[string]SQLColumn{
				"owner":  {Expression: "owner", Presence: "TRUE", Kind: SQLText},
				"amount": {Expression: "amount", Presence: "TRUE", Kind: SQLNumber},
				"at":     {Expression: "at", Presence: "TRUE", Kind: SQLTimestamp},
			},
		}, nil
	}
	definition := Definition{Name: "rates", From: "events", Window: []WindowField{
		{Operation: "change", Field: "amount", As: "rate", Mode: "rate", TimeField: "at", Unit: "hour",
			GroupBy: []string{"owner"}, OrderBy: []OrderField{{Field: "owner"}}},
	}, Select: []SelectedField{{Field: "rate"}}}
	plan, err := CompileSQL([]Definition{definition}, []string{"rates"}, resolver)
	if err != nil {
		t.Fatal(err)
	}
	statement, args, _, err := plan.OutputStatement("rates", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(t.Context(), statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var results []sql.NullString
	for rows.Next() {
		var rate sql.NullString
		var present bool
		if err := rows.Scan(&rate, &present); err != nil {
			t.Fatal(err)
		}
		if !present {
			t.Fatal("rate is missing")
		}
		results = append(results, rate)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 || results[0].Valid || !results[1].Valid || !results[2].Valid ||
		!strings.HasPrefix(results[1].String, "20.") || !strings.HasPrefix(results[2].String, "20.") {
		t.Fatalf("typed timestamp rates and stable ties: %v", results)
	}
}

func TestSQLWindowTextInstantValidationInPostgres(t *testing.T) {
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
	expression := windowInstant(SQLColumn{Expression: "observation", Kind: SQLText})
	for _, input := range []string{
		"not a date", "2026-01-01Taa:00:00Z", "2026-02-30", "2026-13-01", "2026-01-01T25:00:00Z",
		"2026-01-01T00:00:00+99:00", "2026-01-01T00:00:00.123456789+02:00",
		"2026-01-01T00:00:00+23:00", "2026-01-01T00:00:00.125-08:30",
		"2026-09-23",
	} {
		var got sql.NullFloat64
		if err := db.QueryRowContext(t.Context(), "SELECT "+expression+" FROM (SELECT $1::text AS observation) AS x", input).Scan(&got); err != nil {
			t.Fatalf("instant %q: %v", input, err)
		}

		var parsed time.Time
		if len(input) == 10 {
			parsed, err = time.Parse("2006-01-02", input)
		} else {
			parsed, err = time.Parse(time.RFC3339Nano, input)
		}
		if err != nil {
			if got.Valid {
				t.Errorf("invalid instant %q returned %v", input, got.Float64)
			}
		} else if !got.Valid || got.Float64 != float64(parsed.UnixMilli())/1e3 {
			t.Errorf("instant %q = %v, want %v", input, got, parsed)
		}
	}
}

func TestSQLWindowOversizedNumericTextInPostgres(t *testing.T) {
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
	column := SQLColumn{Expression: "observation", Kind: SQLText}
	expression := sqlFinite(sqlNumeric(column))
	for _, testcase := range []struct {
		text string
		want sql.NullFloat64
	}{
		{strings.Repeat("9", 350), sql.NullFloat64{}},
		{strings.Repeat("9", 400), sql.NullFloat64{}},
		{"1e999", sql.NullFloat64{}},
		{"Infinity", sql.NullFloat64{}},
		{"NaN", sql.NullFloat64{}},
		{"12.5", sql.NullFloat64{Float64: 12.5, Valid: true}},
	} {
		var got sql.NullFloat64
		if err := db.QueryRowContext(t.Context(),
			"SELECT "+expression+" FROM (SELECT $1::text AS observation) AS x", testcase.text).Scan(&got); err != nil {
			t.Fatalf("numeric text of length %d: %v", len(testcase.text), err)
		}
		if got != testcase.want {
			t.Errorf("numeric text of length %d = %+v, want %+v", len(testcase.text), got, testcase.want)
		}
	}
}
