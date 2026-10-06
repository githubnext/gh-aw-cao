package query

import (
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func temporalTestInput(values string) SQLRelation {
	return SQLRelation{
		SQL:   "(VALUES " + values + ") AS observation(ordinal, observed_at, repository, amount, direction, amount_present, metric_id, label, missing, missing_present)",
		Order: "ordinal",
		Columns: map[string]SQLColumn{
			"observed-at": {Expression: "observed_at", Presence: "TRUE", Kind: SQLText},
			"repository":  {Expression: "repository", Presence: "TRUE", Kind: SQLText},
			"value":       {Expression: "amount", Presence: "amount_present", Kind: SQLNumber},
			"direction":   {Expression: "direction", Presence: "TRUE", Kind: SQLText},
			"identity":    {Expression: "metric_id", Presence: "TRUE", Kind: SQLText},
			"label":       {Expression: "label", Presence: "TRUE", Kind: SQLText},
			"missing":     {Expression: "missing", Presence: "missing_present", Kind: SQLText},
		},
	}
}

func temporalTestDefinition() TemporalSeries {
	return TemporalSeries{Time: "observed-at", Series: "repository", Shape: "groups",
		Carry:    []string{"repository", "direction", "label", "missing", "undeclared"},
		Measures: []TemporalMeasure{{Field: "value", Key: "identity", Kind: "primary"}},
		Trend:    &TemporalTrend{Direction: "direction"}}
}

func temporalTestPlan(t *testing.T, input SQLRelation, definition TemporalSeries) SQLPlan {
	t.Helper()
	compiler := sqlCompiler{}
	output, err := compiler.temporal(input, definition, "observations")
	if err != nil {
		t.Fatal(err)
	}
	return SQLPlan{CTEs: "WITH " + strings.Join(compiler.ctes, ",\n"),
		Outputs: map[string]SQLRelation{"observations": output}, Args: compiler.args, Steps: compiler.steps}
}

func TestTemporalSQLGroupsCompilation(t *testing.T) {
	input := temporalTestInput(`(1,'2026-01-01'::text,'repo'::text,10::numeric,'increase'::text,true,'metric'::text,'label'::text,NULL::text,false)`)
	plan := temporalTestPlan(t, input, temporalTestDefinition())
	for _, fragment := range []string{
		"AS NOT MATERIALIZED", "pg_input_is_valid", "isfinite(", "GROUP BY",
		"first_value(", "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING",
		"jsonb_agg(jsonb_build_object('x'", `ORDER BY "__at","__order"`,
		"LIMIT 100001", "__count <= 100000", "ELSE 0 END = 1", `"count" >= 2`,
	} {
		if !strings.Contains(plan.CTEs, fragment) {
			t.Errorf("missing temporal SQL contract %q", fragment)
		}
	}
	for _, field := range []string{"trend-start-value", "trend-end-value", "trend-delta", "trend-relative-percent", "trend-observation-count"} {
		if plan.Outputs["observations"].Columns[field].Kind != SQLNumber {
			t.Errorf("%s must be a native numeric column", field)
		}
	}
	for _, field := range []string{"missing", "undeclared"} {
		if plan.Outputs["observations"].Columns[field].Presence == "FALSE" {
			t.Errorf("%s must be explicitly present with null", field)
		}
	}
	if _, exists := plan.Outputs["observations"].Columns["value"]; exists {
		t.Fatal("grouped output must close over chart points, not tidy values")
	}
	if len(plan.Steps) != 3 || plan.Steps[1].Operation != "temporal-series" || plan.Steps[2].Operation != "temporal-groups" {
		t.Fatalf("temporal cardinality accounting is missing: %+v", plan.Steps)
	}
}

func TestTemporalSQLTidyCompilation(t *testing.T) {
	input := temporalTestInput(`(1,'2026-01-01'::text,'repo'::text,10::numeric,'increase'::text,true,'metric'::text,'label'::text,NULL::text,false)`)
	definition := temporalTestDefinition()
	definition.Shape, definition.Trend = "tidy", nil
	definition.Measures[0].Kind = `primary' OR TRUE --`
	plan := temporalTestPlan(t, input, definition)
	if strings.Contains(plan.CTEs, definition.Measures[0].Kind) ||
		!reflect.DeepEqual(plan.Args, []any{"value", definition.Measures[0].Kind}) {
		t.Fatal("metric literals must be bound parameters")
	}
	if strings.Contains(plan.CTEs, "jsonb_") || strings.Contains(plan.CTEs, "GROUP BY") {
		t.Fatal("tidy scalar projection must not serialize or group source rows")
	}
	want := []string{"direction", "label", "metric", "metric-group", "metric-key", "metric-kind", "metric-name", "missing", "repository", "series", "time", "undeclared", "value"}
	if got := sortedSQLFields(plan.Outputs["observations"].Columns); !reflect.DeepEqual(got, want) {
		t.Fatalf("private temporal columns leaked: %v", got)
	}
}

func TestTemporalSQLRejectsInvalidDeclarations(t *testing.T) {
	input := temporalTestInput(`(1,'2026-01-01'::text,'repo'::text,10::numeric,'increase'::text,true,'metric'::text,'label'::text,NULL::text,false)`)
	cases := []TemporalSeries{
		{Time: "observed-at", Series: "repository"},
		{Time: "missing-time", Series: "repository", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}},
		{Time: "value", Series: "repository", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}},
		{Time: "observed-at", Series: "repository", Shape: "other", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}},
		{Time: "observed-at", Series: "repository", Measures: make([]TemporalMeasure, 65)},
		{Time: "observed-at", Series: "repository", Carry: make([]string, 17), Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}},
		{Time: "observed-at", Series: "repository", Measures: []TemporalMeasure{{Field: "value"}}},
		{Time: "observed-at", Series: "repository", Maps: []TemporalMap{{Field: "value", Kind: "primary"}}},
		{Time: "observed-at", Series: "repository", Shape: "groups", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}, Trend: &TemporalTrend{Direction: "direction"}},
		{Time: "observed-at", Series: "repository", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}, Carry: []string{"direction"}, Trend: &TemporalTrend{Direction: "direction"}},
	}
	for index, definition := range cases {
		compiler := sqlCompiler{}
		if _, err := compiler.temporal(input, definition, "bad"); err == nil {
			t.Errorf("invalid temporal declaration %d was admitted", index)
		}
	}
}

func TestTemporalTrendJSONContract(t *testing.T) {
	var definition Definition
	err := json.Unmarshal([]byte(`{"name":"trend","from":"observations","temporal-series":{"time":"at","series":"repo","shape":"groups","carry":["direction"],"measures":[{"field":"value","kind":"primary"}],"trend":{"direction":"direction"}}}`), &definition)
	if err != nil || definition.TemporalSeries.Trend == nil || definition.TemporalSeries.Trend.Direction != "direction" {
		t.Fatalf("trend was dropped by query decoding: %+v %v", definition, err)
	}
	data, err := json.Marshal(definition)
	if err != nil || !strings.Contains(string(data), `"trend":{"direction":"direction"}`) {
		t.Fatalf("trend was dropped by query encoding: %s %v", data, err)
	}
}

func TestTemporalSQLDeployedCampaignQuery(t *testing.T) {
	data, err := os.ReadFile("../../../dashboard/site/dashboard-fragments/campaign-insights.json")
	if err != nil {
		t.Fatal(err)
	}
	var fragment struct {
		Queries []Definition `json:"queries"`
	}
	if err := json.Unmarshal(data, &fragment); err != nil {
		t.Fatal(err)
	}
	for _, definition := range fragment.Queries {
		if definition.Name != "campaign-operational-value-primary-series" {
			continue
		}
		series := definition.TemporalSeries
		if series == nil || series.Shape != "panels" || series.Link != "run-link" {
			t.Fatal("deployed campaign query must return repository panels with point-level links")
		}
		input := SQLRelation{SQL: "observations", Order: "ordinal", Columns: map[string]SQLColumn{}}
		for _, field := range series.Carry {
			input.Columns[field] = SQLColumn{Expression: SQLIdentifier(field), Presence: "TRUE", Kind: SQLText}
		}
		input.Columns[series.Time] = SQLColumn{Expression: "observed_at", Presence: "observed_at_present", Kind: SQLTimestamp}
		input.Columns[series.Series] = SQLColumn{Expression: "repository", Presence: "TRUE", Kind: SQLText}
		input.Columns[series.Link] = SQLColumn{Expression: "run_link", Presence: "link_present", Kind: SQLStructured}
		for _, measure := range series.Measures {
			input.Columns[measure.Field] = SQLColumn{Expression: "amount", Presence: "amount_present", Kind: SQLNumber}
			input.Columns[measure.Key] = SQLColumn{Expression: "identity", Presence: "identity_present", Kind: SQLText}
		}
		plan := temporalTestPlan(t, input, *series)
		if plan.Outputs["observations"].Columns["series"].Kind != SQLStructured {
			t.Fatal("deployed panels must retain grouped chart series")
		}
		for _, fragment := range []string{`jsonb_build_object('link',`, `ORDER BY "__at","__order"`, `ORDER BY "series" COLLATE "C"`} {
			if !strings.Contains(plan.CTEs, fragment) {
				t.Errorf("missing panel SQL contract %q", fragment)
			}
		}
		return
	}
	t.Fatal("deployed campaign temporal query was not found")
}

func temporalTestConnection(t *testing.T) *pgx.Conn {
	t.Helper()
	url := os.Getenv("TEMPORAL_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("TEMPORAL_TEST_POSTGRES_URL is not set")
	}
	connection, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(t.Context()) })
	return connection
}

func temporalTestRows(t *testing.T, connection *pgx.Conn, plan SQLPlan) ([]map[string]any, error) {
	t.Helper()
	relation := plan.Outputs["observations"]
	fields := sortedSQLFields(relation.Columns)
	projection := make([]string, 0, 2*len(fields))
	for _, field := range fields {
		column := relation.Columns[field]
		projection = append(projection, "("+column.Expression+")::text", column.Presence)
	}
	rows, err := connection.Query(t.Context(), plan.CTEs+"\nSELECT "+strings.Join(projection, ",")+
		" FROM "+relation.SQL+" ORDER BY "+relation.Order, plan.Args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := map[string]any{}
		for index, field := range fields {
			if values[2*index+1] != true {
				continue
			}
			value := values[2*index]
			if value != nil {
				switch relation.Columns[field].Kind {
				case SQLNumber:
					value, err = strconv.ParseFloat(value.(string), 64)
				case SQLStructured:
					err = json.Unmarshal([]byte(value.(string)), &value)
				case SQLText, SQLBoolean, SQLTimestamp, sqlNull:
				}
				if err != nil {
					return nil, err
				}
			}
			row[field] = value
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func TestTemporalSQLPostgresGroupedWorkerSemantics(t *testing.T) {
	connection := temporalTestConnection(t)
	input := temporalTestInput(`
		(1,'2026-01-03T00:00:00Z'::text,'repo'::text,15::numeric,'increase'::text,true,'metric'::text,'label'::text,NULL::text,false),
		(2,'2026-01-01T00:00:00Z','repo',10,'increase',true,'metric','label',NULL,false),
		(3,'2026-01-03T00:00:00Z','repo',20,'increase',true,'metric','label',NULL,false),
		(4,'not a date','repo',999,'increase',true,'metric','label',NULL,false),
		(5,'2026-01-04T00:00:00Z','repo','NaN'::numeric,'increase',true,'metric','label',NULL,false),
		(6,'2026-01-04T00:00:00Z','repo','Infinity'::numeric,'increase',true,'metric','label',NULL,false),
		(7,'2026-01-04T00:00:00Z','repo',1e309::numeric,'increase',true,'metric','label',NULL,false),
		(8,'2026-01-04T00:00:00Z','repo',999,'increase',false,'metric','label',NULL,false),
		(9,'today','repo',999,'increase',true,'metric','label',NULL,false),
		(10,'2026-01-04T00:00:00Z','repo',NULL,'increase',true,'metric','label',NULL,false)`)
	rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, temporalTestDefinition()))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"repository": "repo", "direction": "increase", "label": "label", "missing": nil, "undeclared": nil,
		"metric": "metric", "metric-key": "primary:metric", "metric-name": "metric", "metric-kind": "primary", "metric-group": "metric",
		"trend-start-value": float64(10), "trend-end-value": float64(20), "trend-delta": float64(10),
		"trend-relative-percent": float64(100), "trend-observed-direction": "up", "trend-assessment": "improving", "trend-observation-count": float64(3),
		"points": []any{
			map[string]any{"x": "2026-01-01T00:00:00Z", "y": float64(10), "color": "repo", "key": "primary:metric:1"},
			map[string]any{"x": "2026-01-03T00:00:00Z", "y": float64(15), "color": "repo", "key": "primary:metric:0"},
			map[string]any{"x": "2026-01-03T00:00:00Z", "y": float64(20), "color": "repo", "key": "primary:metric:2"},
		},
	}
	if !reflect.DeepEqual(rows, []map[string]any{want}) {
		t.Fatalf("worker temporal result mismatch:\ngot  %#v\nwant %#v", rows, want)
	}
}

func TestTemporalSQLPostgresPanels(t *testing.T) {
	connection := temporalTestConnection(t)
	input := temporalTestInput(`
		(1,'2026-01-03T00:00:00Z'::text,'z'::text,15::numeric,'increase'::text,true,'metric'::text,'label'::text,NULL::text,false),
		(2,'2026-01-01T00:00:00Z','z',10,'increase',true,'metric','label',NULL,false),
		(3,'2026-01-01T00:00:00Z','z',10,'increase',true,'metric','label',NULL,false),
		(4,'2026-01-01T00:00:00Z','a',5,'increase',true,'metric','label',NULL,false),
		(5,'invalid','a',999,'increase',true,'metric','label',NULL,false),
		(6,'2026-01-01T00:00:00Z','a',NULL,'increase',true,'metric','label',NULL,false)`)
	input.Columns["run-link"] = SQLColumn{
		Expression: `jsonb_build_object('href','https://github.com/org/repo/actions/runs/' || ordinal::text)`,
		Presence:   "ordinal <> 4", Kind: SQLStructured,
	}
	definition := TemporalSeries{
		Time: "observed-at", Series: "repository", Shape: "panels", Link: "run-link",
		Carry:    []string{"direction", "label"},
		Measures: []TemporalMeasure{{Field: "value", Key: "identity", Kind: "primary"}},
	}
	rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, definition))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one metric panel, got %v", rows)
	}
	series := rows[0]["series"].([]any)
	if len(series) != 2 || series[0].(map[string]any)["id"] != "a" || series[1].(map[string]any)["id"] != "z" {
		t.Fatalf("expected ordered repository series, got %v", series)
	}
	if _, exists := series[0].(map[string]any)["points"].([]any)[0].(map[string]any)["link"]; exists {
		t.Fatal("missing links must remain absent")
	}
	points := series[1].(map[string]any)["points"].([]any)
	if len(points) != 3 {
		t.Fatalf("duplicate observations were dropped: %v", points)
	}
	for index, run := range []int{2, 3, 1} {
		point := points[index].(map[string]any)
		link := point["link"].(map[string]any)
		if link["href"] != "https://github.com/org/repo/actions/runs/"+strconv.Itoa(run) {
			t.Fatalf("point order or provenance changed: %v", points)
		}
	}
}

func TestTemporalSQLPostgresPanelMetricIdentity(t *testing.T) {
	connection := temporalTestConnection(t)
	input := SQLRelation{
		SQL: `(VALUES (1,'2026-01-02'::text,'z'::text,'{"quality":2}'::jsonb,'[{"id":"quality","name":"Quality"}]'::jsonb),
			(2,'2026-01-01','a','{"quality":1}','[{"id":"quality","name":"Renamed"}]')) AS observations(ordinal,at,repo,metrics,definitions)`,
		Order: "ordinal",
		Columns: map[string]SQLColumn{
			"at":          {Expression: "at", Presence: "TRUE", Kind: SQLText},
			"repo":        {Expression: "repo", Presence: "TRUE", Kind: SQLText},
			"metrics":     {Expression: "metrics", Presence: "TRUE", Kind: SQLStructured},
			"definitions": {Expression: "definitions", Presence: "TRUE", Kind: SQLStructured},
		},
	}
	definition := TemporalSeries{Time: "at", Series: "repo", Shape: "panels",
		Maps: []TemporalMap{{Field: "metrics", Definitions: "definitions", Kind: "diagnostic"}}}
	rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, definition))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["metric-name"] != "Quality" || len(rows[0]["series"].([]any)) != 2 {
		t.Fatalf("renamed metrics must retain one panel and the first label: %v", rows)
	}
}

func TestTemporalSQLPostgresTrendAssessments(t *testing.T) {
	connection := temporalTestConnection(t)
	for _, test := range []struct {
		name, direction, start, end, assessment, observed string
		count                                             int
		relative                                          any
	}{
		{"increase", "increase", "5", "10", "improving", "up", 2, float64(100)},
		{"decrease", "decrease", "10", "5", "improving", "down", 2, float64(-50)},
		{"worsening-up", "decrease", "5", "10", "worsening", "up", 2, float64(100)},
		{"worsening-down", "increase", "10", "5", "worsening", "down", 2, float64(-50)},
		{"flat", "increase", "5", "5", "stable", "flat", 2, float64(0)},
		{"maintain", "maintain", "5", "10", "neutral", "up", 2, float64(100)},
		{"target", "target", "5", "10", "neutral", "up", 2, float64(100)},
		{"negative", "increase", "-10", "-5", "improving", "up", 2, float64(50)},
		{"zero", "increase", "0", "5", "improving", "up", 2, nil},
		{"insufficient", "increase", "5", "NULL", "insufficient", "", 1, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := temporalTestInput("(1,'2026-01-01'::text,'repo'::text," + test.start + "::numeric,'" + test.direction +
				"'::text,true,'metric'::text,'label'::text,NULL::text,false),(2,'2026-01-02','repo'," + test.end +
				",'" + test.direction + "',true,'metric','label',NULL,false)")
			rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, temporalTestDefinition()))
			if err != nil || len(rows) != 1 {
				t.Fatalf("trend execution failed: %#v %v", rows, err)
			}
			row := rows[0]
			if row["trend-assessment"] != test.assessment || row["trend-observation-count"] != float64(test.count) {
				t.Fatalf("wrong trend: %#v", row)
			}
			if test.count < 2 {
				for _, field := range []string{"trend-start-value", "trend-end-value", "trend-delta", "trend-relative-percent", "trend-observed-direction"} {
					if _, exists := row[field]; exists {
						t.Errorf("insufficient trend must omit %s", field)
					}
				}
			} else if row["trend-observed-direction"] != test.observed || row["trend-relative-percent"] != test.relative {
				t.Fatalf("wrong direction or percentage: %#v", row)
			}
		})
	}
}

func TestTemporalSQLPostgresMapsAndDeclarationOrder(t *testing.T) {
	connection := temporalTestConnection(t)
	input := SQLRelation{
		SQL: `(VALUES (1,'2026-01-01'::text,3::numeric,'{"alpha":4,"10":"2","2":true,"invalid":"NaN","null":null}'::jsonb,
			'[{"id":"alpha","name":"old"},{"id":"alpha","name":"Alpha"},{"id":"10","name":""}]'::jsonb),
			(2,'2026-01-02',5,'{"2":false}'::jsonb,'[]'::jsonb)) AS observations(ordinal,at,amount,metrics,definitions)`,
		Order: "ordinal",
		Columns: map[string]SQLColumn{
			"at":          {Expression: "at", Presence: "TRUE", Kind: SQLText},
			"value":       {Expression: "amount", Presence: "TRUE", Kind: SQLNumber},
			"metrics":     {Expression: "metrics", Presence: "TRUE", Kind: SQLStructured},
			"definitions": {Expression: "definitions", Presence: "TRUE", Kind: SQLStructured},
		},
	}
	definition := TemporalSeries{Time: "at", Series: "value",
		Measures: []TemporalMeasure{{Field: "value", Kind: "first"}, {Field: "value", Kind: "second"}},
		Maps:     []TemporalMap{{Field: "metrics", Definitions: "definitions", Kind: "map"}}}
	plan := temporalTestPlan(t, input, definition)
	if !strings.Contains(plan.CTEs, "CROSS JOIN LATERAL") || !strings.Contains(plan.CTEs, "LIMIT 64") {
		t.Fatal("map expansion must stay bounded and relational")
	}
	rows, err := temporalTestRows(t, connection, plan)
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row["metric-key"].(string))
	}
	want := []string{"first:value", "second:value", "map:metrics:2", "map:metrics:10", "map:metrics:alpha",
		"first:value", "second:value", "map:metrics:2"}
	if !reflect.DeepEqual(keys, want) || rows[4]["metric-name"] != "Alpha" || rows[3]["metric-name"] != "10" ||
		rows[2]["value"] != float64(1) || rows[7]["value"] != float64(0) {
		t.Fatalf("map values, names or declaration order differ: %#v", rows)
	}
}

func TestTemporalSQLPostgresMapBound(t *testing.T) {
	connection := temporalTestConnection(t)
	input := SQLRelation{
		SQL: `(SELECT jsonb_object_agg('k'||lpad(index::text,2,'0'),
			CASE WHEN index = 0 THEN NULL::numeric ELSE index::numeric END) AS metrics
			FROM generate_series(0,64) AS index) AS observations`,
		Order: "1",
		Columns: map[string]SQLColumn{
			"at":      {Expression: "'2026-01-01'::text", Presence: "TRUE", Kind: SQLText},
			"series":  {Expression: "'repo'::text", Presence: "TRUE", Kind: SQLText},
			"metrics": {Expression: "metrics", Presence: "TRUE", Kind: SQLStructured},
		},
	}
	definition := TemporalSeries{Time: "at", Series: "series", Maps: []TemporalMap{{Field: "metrics", Kind: "map"}}}
	rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, definition))
	if err != nil || len(rows) != 63 {
		t.Fatalf("only the first 64 map entries may be considered: rows=%d err=%v", len(rows), err)
	}
	if rows[0]["metric"] != "k01" || rows[62]["metric"] != "k63" {
		t.Fatal("invalid entries must not be replaced by entries beyond the map bound")
	}
}

func TestTemporalSQLPostgresProjectionBounds(t *testing.T) {
	connection := temporalTestConnection(t)
	input := SQLRelation{SQL: "generate_series(1,100001) AS ordinal", Order: "ordinal",
		Columns: map[string]SQLColumn{
			"at":     {Expression: "'2026-01-01T00:00:00Z'::timestamptz", Presence: "TRUE", Kind: SQLTimestamp},
			"series": {Expression: "'repo'::text", Presence: "TRUE", Kind: SQLText},
			"value":  {Expression: "1::numeric", Presence: "TRUE", Kind: SQLNumber},
		}}
	for _, shape := range []string{"tidy", "groups", "panels"} {
		definition := TemporalSeries{Time: "at", Series: "series", Shape: shape, Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}}
		if _, err := temporalTestRows(t, connection, temporalTestPlan(t, input, definition)); err == nil {
			t.Fatalf("%s must fail before emitting more than 100k points", shape)
		}
	}
	input.SQL = "generate_series(1,100000) AS ordinal"
	definition := TemporalSeries{Time: "at", Series: "series", Shape: "groups", Measures: []TemporalMeasure{{Field: "value", Kind: "primary"}}}
	rows, err := temporalTestRows(t, connection, temporalTestPlan(t, input, definition))
	if err != nil || len(rows) != 1 || len(rows[0]["points"].([]any)) != 100000 {
		t.Fatalf("100k points should fit exactly: rows=%d err=%v", len(rows), err)
	}
}
