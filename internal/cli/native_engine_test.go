package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

func engineTestDefinition(t *testing.T, text string) nativeRow {
	t.Helper()
	var def nativeRow
	if err := json.Unmarshal([]byte(text), &def); err != nil {
		t.Fatal(err)
	}
	if _, ok := def["name"]; !ok {
		def["name"] = "test"
	}
	if _, ok := def["from"]; !ok {
		def["from"] = "input"
	}
	return def
}

func engineTestExecute(t *testing.T, def nativeRow, rows []nativeRow) []nativeRow {
	t.Helper()
	result, err := executeNativeQuery(context.Background(), def, func(string) ([]nativeRow, error) { return rows, nil })
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func engineTestEqual(t *testing.T, actual, expected any) {
	t.Helper()
	a, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	e, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	var normalizedA, normalizedE any
	if err = json.Unmarshal(a, &normalizedA); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(e, &normalizedE); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(normalizedA, normalizedE) {
		t.Fatalf("result differs\nactual: %s\nexpect: %s", a, e)
	}
}

func TestNativeEngineProjectionAndMissing(t *testing.T) {
	rows := []nativeRow{{"id": 1, "explicit": nil, "drop": true}, {"id": 2}}
	def := engineTestDefinition(t, `{"select":[{"field":"id","as":"key"},{"field":"explicit"},{"field":"missing"}]}`)
	result := engineTestExecute(t, def, rows)
	engineTestEqual(t, result, []nativeRow{{"key": 1, "explicit": nil}, {"key": 2}})
	result[0]["key"] = 99
	if rows[0]["id"] != 1 {
		t.Fatal("source map mutated")
	}
	raw := engineTestExecute(t, engineTestDefinition(t, `{}`), rows)
	raw[0]["id"] = 10
	if rows[0]["id"] != 1 {
		t.Fatal("raw source maps were not copied")
	}
	empty := engineTestExecute(t, engineTestDefinition(t, `{}`), nil)
	engineTestEqual(t, empty, []nativeRow{})
}

func TestNativeEngineFilterSemantics(t *testing.T) {
	rows := []nativeRow{
		{"id": "missing"}, {"id": "null", "v": nil}, {"id": "empty", "v": ""},
		{"id": "unknown", "v": "unknown"}, {"id": "numeric", "v": 1},
		{"id": "text", "v": "1"}, {"id": "boolean", "v": false}, {"id": "object", "v": nativeRow{"a": 1}},
	}
	tests := []struct {
		filter string
		ids    []string
	}{
		{`{"predicates":[{"field":"v","equals":"unknown"}]}`, []string{"missing", "null", "unknown"}},
		{`{"predicates":[{"field":"v","equals":1}]}`, []string{"numeric", "text"}},
		{`{"predicates":[{"field":"v","in":[false]}]}`, []string{"boolean"}},
		{`{"predicates":[{"field":"v","equals":1,"optional":true}]}`, []string{"missing", "null", "empty", "numeric", "text"}},
		{`{"predicates":[{"field":"v","includes":"OBJECT"}]}`, []string{"object"}},
		{`{"search":{"fields":["v"],"query":"  FALSE  "}}`, []string{"boolean"}},
		{`{"predicates":[{"field":"v","gte":1,"lt":2}]}`, []string{"numeric", "text"}},
	}
	for _, test := range tests {
		t.Run(test.filter, func(t *testing.T) {
			def := engineTestDefinition(t, `{"filter":`+test.filter+`}`)
			result := engineTestExecute(t, def, rows)
			ids := []string{}
			for _, row := range result {
				ids = append(ids, engineString(row["id"]))
			}
			engineTestEqual(t, ids, test.ids)
		})
	}
	temporal := engineTestDefinition(t, `{"filter":{"predicates":[{"field":"@time","gte":"2026-01-01","lt":"2026-02-01"}]}}`)
	times := []nativeRow{
		{"id": 1, "observed-at": "2026-01-05T00:00:00Z"},
		{"id": 2, "started-at": "2025-01-01T00:00:00Z"},
		{"id": 3}, {"id": 4, "observed-at": "bad", "started-at": "2025-01-01T00:00:00Z"},
	}
	engineTestEqual(t, engineTestExecute(t, temporal, times), []nativeRow{times[0], times[2], times[3]})
}

func TestNativeEngineComputeAndAggregate(t *testing.T) {
	def := engineTestDefinition(t, `{
	  "compute":[
	    {"as":"n","function":"number","args":[{"field":"v"}]},
	    {"as":"doubled","function":"product","args":[{"field":"n"},{"value":2}]},
	    {"as":"label","function":"concat","args":[{"value":"v="},{"field":"doubled"}]},
	    {"as":"zero","function":"quotient","args":[{"field":"n"},{"value":0}]},
	    {"as":"chosen","function":"coalesce","args":[{"field":"empty"},{"field":"v"},{"value":"fallback"}]}
	  ],
	  "select":[{"field":"n"},{"field":"doubled"},{"field":"label"},{"field":"zero"},{"field":"chosen"}]
	}`)
	engineTestEqual(t, engineTestExecute(t, def, []nativeRow{{"v": "3"}, {"v": false}, {"v": " "}, {"v": ""}}), []nativeRow{
		{"n": 3, "doubled": 6, "label": "v=6", "zero": nil, "chosen": "3"},
		{"n": nil, "doubled": nil, "label": "v=", "zero": nil, "chosen": false},
		{"n": 0, "doubled": 0, "label": "v=0", "zero": nil, "chosen": " "},
		{"n": nil, "doubled": nil, "label": "v=", "zero": nil, "chosen": "fallback"},
	})
	aggregate := engineTestDefinition(t, `{"aggregate":{"values":[
	  {"field":"v","as":"count","reducer":"count"},
	  {"field":"v","as":"sum","reducer":"sum"},
	  {"field":"v","as":"median","reducer":"median"},
	  {"field":"v","as":"p95","reducer":"p95"},
	  {"field":"v","as":"distinct","reducer":"distinct-list"},
	  {"field":"v","as":"filtered","reducer":"count","filter":{"predicates":[{"field":"status","in":["ok"]}]}}
	]}}`)
	values := []nativeRow{{"v": 1, "status": "ok"}, {"v": "3"}, {"v": true}, {"v": ""}, {}, {"v": nil}}
	engineTestEqual(t, engineTestExecute(t, aggregate, values), []nativeRow{{"count": 3, "sum": 5, "median": 1, "p95": 2.8, "distinct": "1, 3, true", "filtered": 1}})
	engineTestEqual(t, engineTestExecute(t, aggregate, nil), []nativeRow{{"count": 0, "sum": 0, "median": nil, "p95": nil, "distinct": "", "filtered": 0}})
	grouped := engineTestDefinition(t, `{"aggregate":{"by":["g"],"values":[{"field":"v","as":"value","reducer":"unique"}]}}`)
	engineTestEqual(t, engineTestExecute(t, grouped, []nativeRow{{"g": "a", "v": ""}, {"g": "a", "v": ""}, {"g": "b", "v": 1}, {"g": "b", "v": "1"}}), []nativeRow{{"g": "a", "value": ""}, {"g": "b", "value": nil}})
}

func TestNativeEngineJoinAndOptionalSources(t *testing.T) {
	def := engineTestDefinition(t, `{"union":["optional"],"joins":[{"source":"right","type":"left","on":[{"left":"id","right":"id"}],"fields":[{"field":"name","as":"joined"}]}]}`)
	sources := map[string][]nativeRow{
		"input": {{"id": 1}, {"id": " 2 "}, {"id": nil}, {"id": ""}, {"id": nativeRow{"a": 1}}},
		"right": {{"id": "1", "name": "one"}, {"id": 2, "name": "two"}, {"id": nil, "name": "never"}},
	}
	result, err := executeNativeQuery(context.Background(), def, func(name string) ([]nativeRow, error) {
		if rows, ok := sources[name]; ok {
			return rows, nil
		}
		return nil, errors.New("missing")
	})
	if err != nil {
		t.Fatal(err)
	}
	engineTestEqual(t, result, []nativeRow{{"id": 1, "joined": "one"}, {"id": " 2 ", "joined": "two"}, {"id": nil, "joined": nil}, {"id": "", "joined": nil}, {"id": nativeRow{"a": 1}, "joined": nil}})
	sources["right"] = append(sources["right"], nativeRow{"id": "1", "name": "duplicate"})
	_, err = executeNativeQuery(context.Background(), def, func(name string) ([]nativeRow, error) { return sources[name], nil })
	var unavailable *NativeQueryUnavailableError
	if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), "more than one") {
		t.Fatalf("expected duplicate-key rejection, got %v", err)
	}
	joins := engineList(def["joins"])
	engineMap(joins[0])["type"] = "inner-many"
	result, err = executeNativeQuery(context.Background(), def, func(name string) ([]nativeRow, error) { return sources[name], nil })
	if err != nil || len(result) != 3 {
		t.Fatalf("inner-many expansion: %v %v", result, err)
	}
	_, err = executeNativeQuery(context.Background(), def, func(string) ([]nativeRow, error) { return nil, errors.New("offline") })
	if !errors.As(err, &unavailable) || unavailable.Source != "input" {
		t.Fatalf("expected typed input-unavailable, got %v", err)
	}
}

func TestNativeEngineWindows(t *testing.T) {
	def := engineTestDefinition(t, `{"window":[
	  {"field":"v","as":"previous","operation":"previous","order-by":[{"field":"day"}],"groupby":["g"]},
	  {"field":"v","as":"rank","operation":"row-number","order-by":[{"field":"day"}],"groupby":["g"]},
	  {"field":"v","as":"rolling","operation":"rolling","frame":2,"reducer":"sum","order-by":[{"field":"day"}],"groupby":["g"]},
	  {"field":"v","as":"centered","operation":"rolling","frame":3,"alignment":"centered","order-by":[{"field":"day"}],"groupby":["g"]},
	  {"field":"v","as":"delta","operation":"change","mode":"percentage","order-by":[{"field":"day"}],"groupby":["g"]},
	  {"field":"v","as":"rate","operation":"change","mode":"rate","time-field":"day","unit":"day","order-by":[{"field":"day"}],"groupby":["g"]}
	]}`)
	rows := []nativeRow{{"g": "a", "day": "2026-01-03", "v": 6}, {"g": "a", "day": "2026-01-01", "v": 2}, {"g": "b", "day": "2026-01-01", "v": 7}, {"g": "a", "day": "2026-01-02", "v": 4}}
	result := engineTestExecute(t, def, rows)
	engineTestEqual(t, result, []nativeRow{
		{"g": "a", "day": "2026-01-03", "v": 6, "previous": 4, "rank": 3, "rolling": 10, "centered": nil, "delta": 50, "rate": 2},
		{"g": "a", "day": "2026-01-01", "v": 2, "previous": nil, "rank": 1, "rolling": 2, "centered": nil, "delta": nil, "rate": nil},
		{"g": "b", "day": "2026-01-01", "v": 7, "previous": nil, "rank": 1, "rolling": 7, "centered": nil, "delta": nil, "rate": nil},
		{"g": "a", "day": "2026-01-02", "v": 4, "previous": 2, "rank": 2, "rolling": 6, "centered": 4, "delta": 100, "rate": 2},
	})
}

func TestNativeEnginePrediction(t *testing.T) {
	tests := []struct {
		method string
		f      func(float64) float64
	}{
		{"linear", func(x float64) float64 { return 2 + 3*x }},
		{"quad", func(x float64) float64 { return 2 + 3*x + x*x }},
		{"poly", func(x float64) float64 { return 2 + 3*x + x*x + x*x*x }},
		{"log", func(x float64) float64 { return 2 + 3*math.Log(x) }},
		{"exp", func(x float64) float64 { return math.Exp(2 + .3*x) }},
		{"pow", func(x float64) float64 { return 2 * x * x * x }},
	}
	for _, test := range tests {
		t.Run(test.method, func(t *testing.T) {
			rows := []nativeRow{}
			for x := float64(1); x <= 5; x++ {
				rows = append(rows, nativeRow{"x": x, "y": test.f(x)})
			}
			rows = append(rows, nativeRow{"x": 6, "y": nil}, nativeRow{"x": nil, "y": 1})
			def := engineTestDefinition(t, fmt.Sprintf(`{"predict":[{"field":"y","on":"x","as":"predicted","method":%q}]}`, test.method))
			result := engineTestExecute(t, def, rows)
			for i := 0; i < 6; i++ {
				actual, ok := engineNumber(result[i]["predicted"])
				expected := test.f(float64(i + 1))
				if !ok || math.Abs(actual-expected) > 1e-8*math.Max(math.Abs(expected), 1) {
					t.Fatalf("prediction %d: got %v, expected %v", i, result[i]["predicted"], expected)
				}
			}
			if result[6]["predicted"] != nil {
				t.Fatal("missing predictor was not null")
			}
		})
	}
	def := engineTestDefinition(t, `{"predict":[{"field":"y","on":["x","z"],"as":"p"}]}`)
	rows := []nativeRow{{"x": 1, "z": 0, "y": 3}, {"x": 0, "z": 1, "y": 4}, {"x": 2, "z": 2, "y": 11}, {"x": 3, "z": 5}}
	result := engineTestExecute(t, def, rows)
	actual, _ := engineNumber(result[3]["p"])
	if math.Abs(actual-22) > 1e-8 {
		t.Fatalf("multivariate forecast: %v", result)
	}
}

func TestNativeEngineTemporalAndFacet(t *testing.T) {
	rows := []nativeRow{
		{"t": "2026-01-02", "s": "b", "v": 3, "direction": "increase", "run": "2"},
		{"t": "2026-01-01", "s": "a", "v": 1, "direction": "increase", "run": "1"},
		{"t": "invalid", "s": "a", "v": 9},
	}
	def := engineTestDefinition(t, `{"temporal-series":{"time":"t","series":"s","shape":"groups","carry":["direction"],"measures":[{"field":"v","kind":"value"}],"trend":{"direction":"direction"}}}`)
	result := engineTestExecute(t, def, rows)
	if len(result) != 1 || result[0]["trend-assessment"] != "improving" || result[0]["trend-delta"] != float64(2) {
		t.Fatalf("temporal trend: %v", result)
	}
	points := result[0]["points"].([]nativeRow)
	if points[0]["x"] != "2026-01-01" || points[0]["color"] != "a" {
		t.Fatalf("temporal points not sorted: %v", points)
	}
	def = engineTestDefinition(t, `{"temporal-series":{"time":"t","series":"s","shape":"panels","point-carry":["run"],"measures":[{"field":"v","kind":"value"}]}}`)
	result = engineTestExecute(t, def, rows)
	if len(result) != 1 || len(result[0]["series"].([]nativeRow)) != 2 {
		t.Fatalf("temporal panels: %v", result)
	}
	panel := result[0]["series"].([]nativeRow)[0]
	if panel["id"] != "a" || panel["points"].([]nativeRow)[0]["metadata"].(nativeRow)["run"] != "1" {
		t.Fatalf("temporal point metadata: %v", panel)
	}
	def = engineTestDefinition(t, `{"limit":2,"facet":{"field":"g","as":"rows"}}`)
	result = engineTestExecute(t, def, []nativeRow{{"g": 1}, {"g": "1"}, {"g": 2}})
	if len(result) != 2 || len(result[0]["rows"].([]nativeRow)) != 1 || len(result[1]["rows"].([]nativeRow)) != 1 {
		t.Fatalf("facet lost scalar identity or ran before limit: %v", result)
	}
}

func TestNativeEngineValidationAndBudgets(t *testing.T) {
	for _, text := range []string{
		`{"unsupported":true}`, `{"joins":[{"source":"x","on":[],"fields":[]}]}`,
		`{"compute":[{"as":"x","function":"eval","args":[{"value":"code"}]}]}`,
		`{"compute":[{"as":"x","function":"number","args":[]}]}`,
		`{"compute":[{"as":"x","function":"number","args":[{"context":"unknown"}]}]}`,
		`{"filter":{"predicates":[{"field":"x","regex":"."}]}}`,
		`{"aggregate":{"values":[{"field":"x","as":"x","reducer":"magic"}]}}`,
		`{"aggregate":{"values":[]}}`, `{"limit":0}`, `{"limit":100001}`, `{"limit":1.5}`,
		`{"window":[{"field":"x","as":"x","operation":"rolling","frame":2,"alignment":"centered","order-by":[{"field":"x"}]}]}`,
		`{"predict":[{"field":"x","as":"x","on":"v","method":"script"}]}`,
		`{"facet":{"field":"x","as":"facet-field"}}`,
		`{"temporal-series":{"time":"x","series":"s","shape":"bad","measures":[{"field":"x","kind":"value"}]}}`,
	} {
		t.Run(text, func(t *testing.T) {
			called := false
			_, err := executeNativeQuery(context.Background(), engineTestDefinition(t, text), func(string) ([]nativeRow, error) { called = true; return nil, nil })
			var unavailable *NativeQueryUnavailableError
			if !errors.As(err, &unavailable) || called {
				t.Fatalf("definition was not rejected before reading: %v called=%v", err, called)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := executeNativeQuery(ctx, engineTestDefinition(t, `{}`), func(string) ([]nativeRow, error) { t.Fatal("cancelled query loaded a source"); return nil, nil })
	var cancelled *NativeQueryCancelledError
	if !errors.As(err, &cancelled) || !errors.Is(err, context.Canceled) {
		t.Fatalf("context cancellation: %v", err)
	}
	budget := &engineBudget{ctx: context.Background(), deadline: time.Now().Add(-time.Second)}
	if err := budget.spend(0); !errors.As(err, &cancelled) || cancelled.Kind != "timeout" {
		t.Fatalf("timeout: %v", err)
	}
	budget.deadline = time.Now().Add(time.Minute)
	if err := budget.spend(engineMaxOperations + 1); !errors.As(err, &cancelled) || cancelled.Kind != "budget" {
		t.Fatalf("operation budget: %v", err)
	}
	many := make([]nativeRow, engineMaxInputRows+1)
	_, err = executeNativeQuery(context.Background(), engineTestDefinition(t, `{}`), func(string) ([]nativeRow, error) { return many, nil })
	var unavailable *NativeQueryUnavailableError
	if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), "max-input-rows") {
		t.Fatalf("input row budget: %v", err)
	}
	many = make([]nativeRow, engineMaxOutputRows+1)
	for i := range many {
		many[i] = nativeRow{"id": i}
	}
	_, err = executeNativeQuery(context.Background(), engineTestDefinition(t, `{}`), func(string) ([]nativeRow, error) { return many, nil })
	if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), "max-output-rows") {
		t.Fatalf("output row budget: %v", err)
	}
	bounded := engineTestDefinition(t, `{"limit":2}`)
	if len(engineTestExecute(t, bounded, many)) != 2 {
		t.Fatal("authored limit did not bound output")
	}
}

type engineOracleCase struct {
	Label      string                 `json:"label"`
	Definition nativeRow              `json:"definition"`
	Sources    map[string][]nativeRow `json:"sources"`
}

func engineTestRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate repository")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
}

func engineCorpusDefinitions(t *testing.T) []nativeRow {
	t.Helper()
	root := engineTestRoot(t)
	paths := []string{filepath.Join(root, "dashboard/site/dashboard.json"), filepath.Join(root, "dashboard/site/src/data/queries/database.json")}
	fragments, err := filepath.Glob(filepath.Join(root, "dashboard/site/dashboard-fragments/*.json"))
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, fragments...)
	definitions := []nativeRow{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var document any
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		queries := engineList(document)
		if mapping := engineMap(document); mapping != nil {
			if dashboard := engineMap(mapping["dashboard"]); dashboard != nil {
				mapping = dashboard
			}
			queries = engineList(mapping["queries"])
		}
		for _, item := range queries {
			def := engineMap(item)
			if engineString(def["from"]) != "" {
				definitions = append(definitions, engineTestResolveOperands(def).(map[string]any))
			}
		}
	}
	if len(definitions) < 300 {
		t.Fatalf("reviewed corpus unexpectedly small: %d", len(definitions))
	}
	return definitions
}

func engineTestResolveOperands(value any) any {
	if mapping := engineMap(value); mapping != nil {
		// The production parameter/context compiler resolves these scalar
		// operands before handing a definition to either evaluator.
		if engineHas(mapping, "parameter") || engineHas(mapping, "context") {
			return nativeRow{"value": nil}
		}
		result := nativeRow{}
		for key, value := range mapping {
			result[key] = engineTestResolveOperands(value)
		}
		return result
	}
	if values := engineList(value); values != nil {
		result := make([]any, len(values))
		for i, value := range values {
			result[i] = engineTestResolveOperands(value)
		}
		return result
	}
	return value
}

func TestNativeEngineReviewedCorpusVocabulary(t *testing.T) {
	for _, def := range engineCorpusDefinitions(t) {
		t.Run(engineString(def["name"]), func(t *testing.T) {
			if err := engineValidate(def); err != nil {
				t.Fatalf("%s: %v", engineDescribeDefinition(def), err)
			}
			if _, err := executeNativeQuery(context.Background(), def, func(string) ([]nativeRow, error) { return []nativeRow{}, nil }); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeEngineJSParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed only for the baseline parity oracle")
	}
	cases := engineOracleFixtures(t)
	for _, def := range engineCorpusDefinitions(t) {
		sources := map[string][]nativeRow{}
		names := []string{engineString(def["from"])}
		names = append(names, engineFields(def["union"])...)
		for _, item := range engineList(def["joins"]) {
			names = append(names, engineString(engineMap(item)["source"]))
		}
		for _, name := range names {
			sources[name] = []nativeRow{}
		}
		cases = append(cases, engineOracleCase{Label: "corpus-empty/" + engineString(def["name"]), Definition: def, Sources: sources})
		populated := map[string][]nativeRow{}
		for _, name := range names {
			populated[name] = []nativeRow{engineTestCorpusRow(def)}
		}
		cases = append(cases, engineOracleCase{Label: "corpus-populated/" + engineString(def["name"]), Definition: def, Sources: populated})
	}
	input, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	script := `
import { readFileSync } from 'node:fs';
import { executeDashboardQuery } from './dashboard/site/src/data/queries/declarative.js';
const cases = JSON.parse(readFileSync(0, 'utf8'));
const output = cases.map(test => {
  const sources = Object.fromEntries(Object.entries(test.sources).map(([name, rows]) => [name, {rows}]));
  const result = executeDashboardQuery(test.definition, sources);
  const rows = result.rows;
  return { label: test.label, unavailable: result.metadata.availability === 'unavailable', rows };
});
process.stdout.write(JSON.stringify(output));
`
	cmd := exec.Command(node, "--input-type=module", "-e", script)
	cmd.Dir = engineTestRoot(t)
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("baseline oracle: %v: %s", err, stderr.String())
	}
	var expected []struct {
		Label       string      `json:"label"`
		Unavailable bool        `json:"unavailable"`
		Rows        []nativeRow `json:"rows"`
	}
	if err := json.Unmarshal(output, &expected); err != nil {
		t.Fatal(err)
	}
	for i, test := range cases {
		t.Run(test.Label, func(t *testing.T) {
			actual, err := executeNativeQuery(context.Background(), test.Definition, func(name string) ([]nativeRow, error) {
				rows, ok := test.Sources[name]
				if !ok {
					return nil, errors.New("source unavailable")
				}
				return rows, nil
			})
			if expected[i].Unavailable {
				var unavailable *NativeQueryUnavailableError
				if !errors.As(err, &unavailable) {
					t.Fatalf("baseline unavailable, native returned %v / %v", actual, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			// Regression fits can differ by a few ULPs across Go/V8 math.
			engineOracleEqual(t, actual, expected[i].Rows)
		})
	}
}

func engineOracleEqual(t *testing.T, left, right any) {
	t.Helper()
	normalize := func(value any) any {
		data, _ := json.Marshal(value)
		var normalized any
		if err := json.Unmarshal(data, &normalized); err != nil {
			t.Fatal(err)
		}
		return normalized
	}
	var compare func(any, any) bool
	compare = func(a, b any) bool {
		switch av := a.(type) {
		case float64:
			bv, ok := b.(float64)
			return ok && math.Abs(av-bv) <= 1e-10*math.Max(1, math.Abs(bv))
		case []any:
			bv, ok := b.([]any)
			if !ok || len(av) != len(bv) {
				return false
			}
			for i := range av {
				if !compare(av[i], bv[i]) {
					return false
				}
			}
			return true
		case map[string]any:
			bv, ok := b.(map[string]any)
			if !ok || len(av) != len(bv) {
				return false
			}
			for key, value := range av {
				other, ok := bv[key]
				if !ok || !compare(value, other) {
					return false
				}
			}
			return true
		default:
			return reflect.DeepEqual(a, b)
		}
	}
	if !compare(normalize(left), normalize(right)) {
		a, _ := json.Marshal(left)
		b, _ := json.Marshal(right)
		t.Fatalf("Go/JS parity differs\nGo: %s\nJS: %s", a, b)
	}
}

func engineOracleFixtures(t *testing.T) []engineOracleCase {
	t.Helper()
	cases := []engineOracleCase{}
	add := func(label, definition string, rows []nativeRow) {
		if rows == nil {
			rows = []nativeRow{}
		}
		cases = append(cases, engineOracleCase{Label: label, Definition: engineTestDefinition(t, definition), Sources: map[string][]nativeRow{"input": rows}})
	}
	args := []any{
		nil, "", " ", "42", "0x10", "0b11", "0o12", false, true, 0, -4, 1.23456,
		"2026-01-03T12:34:56.789Z", "2026-01-03", "one-two_three", "a b/!'()*", []any{1, nil, "x"}, nativeRow{"href": "https://example.test", "label": "Example"},
		"2026-02-30", "2026-02-30T12:00:00Z", "2026-01-03T24:00:00Z", "éclair", "Alpha", "alpha",
		"İSTANBUL", "ΟΣ", "ß_test", "\uFEFF 4 \uFEFF", "\u0085sample\u0085",
	}
	rows := []nativeRow{}
	for i, value := range args {
		rows = append(rows, nativeRow{"id": i, "v": value, "s": "success"})
	}
	names := make([]string, 0, len(engineComputeArity))
	for name := range engineComputeArity {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		arguments := []nativeRow{{"field": "v"}}
		switch name {
		case "coalesce", "concat", "sum", "product", "difference", "quotient", "greater-than", "equals-any", "positive-integer", "link":
			arguments = append(arguments, nativeRow{"value": 2})
		case "replace-suffix":
			arguments = append(arguments, nativeRow{"value": "three"}, nativeRow{"value": "THREE"})
		case "date-bucket":
			arguments = append(arguments, nativeRow{"value": "week"})
		case "calendar-week-point":
			arguments = append(arguments, nativeRow{"value": "2026-01-06T00:00:00Z"}, nativeRow{"field": "s"})
		case "failure-streak-point":
			arguments = append(arguments, nativeRow{"field": "id"}, nativeRow{"value": true})
		case "dashboard-link":
			arguments = append(arguments, nativeRow{"value": "#page-home"}, nativeRow{"value": "Home"})
		case "if":
			arguments = append(arguments, nativeRow{"value": "yes"}, nativeRow{"value": "no"})
		}
		def := nativeRow{"name": "test", "from": "input", "compute": []nativeRow{{"as": "out", "function": name, "args": arguments}}}
		cases = append(cases, engineOracleCase{Label: "compute/" + name, Definition: def, Sources: map[string][]nativeRow{"input": rows}})
	}
	summaries := []nativeRow{}
	for _, reducer := range []string{"count", "distinct-count", "distinct-list", "distinct-values", "sum", "mean", "min", "max", "unique", "median", "p75", "p90", "p95", "calendar-week-rhythm", "latest-failure-streak"} {
		summaries = append(summaries, nativeRow{"field": "v", "as": reducer, "reducer": reducer})
	}
	cases = append(cases, engineOracleCase{Label: "all-reducers", Definition: nativeRow{"from": "input", "aggregate": nativeRow{"values": summaries}}, Sources: map[string][]nativeRow{"input": rows}})
	for _, predicate := range []string{
		`{"field":"v","equals":"unknown"}`, `{"field":"v","equals":null}`,
		`{"field":"v","equals":"false"}`, `{"field":"v","equals":42}`,
		`{"field":"v","in":["unknown",0,true]}`, `{"field":"v","includes":"EXAMPLE"}`,
		`{"field":"v","gte":0,"lt":10}`, `{"field":"v","gte":"2026-01-01","lt":"2026-02-01"}`,
		`{"field":"v","equals":42,"optional":true}`,
	} {
		add("filter/"+predicate, `{"filter":{"predicates":[`+predicate+`]}}`, rows)
	}
	add("ordering/ascending", `{"order-by":[{"field":"v"}]}`, rows)
	add("ordering/descending", `{"order-by":[{"field":"v","direction":"desc"}]}`, rows)
	add("empty-aggregate", `{"aggregate":{"values":[{"field":"v","as":"n","reducer":"count"},{"field":"v","as":"sum","reducer":"sum"}]}}`, nil)
	add("compute/unbound-operands", `{"compute":[{"as":"start","function":"timestamp","args":[{"context":"time-start"}]},{"as":"end","function":"timestamp","args":[{"context":"time-end"}]},{"as":"parameter","function":"coalesce","args":[{"parameter":"unset"},{"value":"fallback"}]}]}`, []nativeRow{{"id": 1}})
	add("grouping/missing-null", `{"aggregate":{"by":["g"],"values":[{"field":"v","as":"n","reducer":"count"}]}}`, []nativeRow{{"v": 1}, {"g": nil, "v": 2}, {"g": 1, "v": 3}, {"g": "1", "v": 4}})
	add("aggregate/filtered", `{"aggregate":{"values":[{"field":"v","as":"n","reducer":"count","filter":{"predicates":[{"field":"g","in":["a"]}]}}]}}`, []nativeRow{{"g": "a", "v": 1}, {"g": "b", "v": 2}})
	add("facet/grid", `{"facet":{"row":"r","column":"c","as":"entries"}}`, []nativeRow{{"r": "a", "c": 1}, {"r": "a", "c": 2}, {"r": "b", "c": 1}, {"r": nil, "c": 1}, {"c": 1}})
	for _, shape := range []string{"tidy", "groups", "panels"} {
		extra := ""
		switch shape {
		case "groups":
			extra = `,"trend":{"direction":"preferred"}`
		case "panels":
			extra = `,"point-carry":["run"],"link":"link"`
		}
		add("temporal/"+shape, `{"temporal-series":{"time":"t","series":"s","shape":"`+shape+`","carry":["preferred"],"measures":[{"field":"v","kind":"measure"}],"maps":[{"field":"metrics","definitions":"definitions","kind":"metrics"}]`+extra+`}}`, []nativeRow{
			{"t": "2026-01-02", "s": "b", "v": 3, "metrics": nativeRow{"a": 4, "b": 5}, "definitions": []nativeRow{{"id": "a", "name": "Alpha"}}, "preferred": "increase", "run": "2", "link": nativeRow{"href": "https://example.test/2"}},
			{"t": "2026-01-01", "s": "a", "v": 1, "metrics": nativeRow{"a": 2, "b": 3}, "preferred": "increase", "run": "1"},
			{"t": "invalid", "s": "a", "v": 9},
		})
	}
	windowRows := []nativeRow{{"g": "a", "day": "2026-01-03", "v": 6}, {"g": "a", "day": "2026-01-01", "v": 2}, {"g": "b", "day": "2026-01-01", "v": 7}, {"g": "a", "day": "2026-01-02", "v": 4}, {"g": "b", "day": nil, "v": nil}}
	for _, window := range []string{
		`"operation":"previous"`, `"operation":"row-number"`,
		`"operation":"rolling","frame":2`, `"operation":"rolling","frame":3,"alignment":"centered","reducer":"sum"`,
		`"operation":"change"`, `"operation":"change","mode":"percentage"`,
		`"operation":"change","mode":"rate","time-field":"day","unit":"day"`,
	} {
		add("window/"+window, `{"window":[{"field":"v","as":"out","order-by":[{"field":"day"}],"groupby":["g"],`+window+`}]}`, windowRows)
		add("window-inplace/"+window, `{"window":[{"field":"v","as":"v","order-by":[{"field":"day"}],"groupby":["g"],`+window+`}]}`, windowRows)
	}
	for _, method := range []string{"linear", "log", "exp", "pow", "quad", "poly"} {
		add("predict/"+method, `{"predict":[{"field":"y","on":"x","as":"out","method":"`+method+`"}]}`, []nativeRow{{"x": 1, "y": 3}, {"x": 2, "y": 5}, {"x": 3, "y": 7}, {"x": 4, "y": 9}, {"x": 5, "y": nil}, {"x": nil, "y": 10}})
	}
	joinDef := engineTestDefinition(t, `{"union":["extra","missing"],"joins":[{"source":"right","type":"left","on":[{"left":"id","right":"id"}],"fields":[{"field":"v","as":"joined"}]}],"select":[{"field":"id"},{"field":"joined"}]}`)
	cases = append(cases, engineOracleCase{Label: "join/union-left", Definition: joinDef, Sources: map[string][]nativeRow{"input": {{"id": 1}, {"id": nil}, {"id": ""}, {"id": false}}, "extra": {{"id": " 2 "}}, "right": {{"id": "1", "v": 5}, {"id": 2, "v": 10}, {"id": "false", "v": 20}}}})
	return cases
}

func engineTestCorpusRow(def nativeRow) nativeRow {
	row := nativeRow{
		"id": "identity", "run": "123", "runId": "identity", "workflowId": "identity",
		"repositoryId": "identity", "organization": "octo", "owner": "octo", "repository": "repo", "name": "sample",
		"timestamp": "2026-01-02T12:00:00Z", "startedAt": "2026-01-02T11:00:00Z", "endedAt": "2026-01-02T12:00:00Z",
		"observed-at": "2026-01-02T12:00:00Z", "started-at": "2026-01-02T11:00:00Z", "ended-at": "2026-01-02T12:00:00Z",
		"status": "success", "conclusion": "success", "active": true, "workflow": ".github/workflows/sample.md",
		"url": "https://github.com/octo/repo/actions/runs/123", "href": "https://github.com/octo/repo",
		"link": nativeRow{"href": "https://github.com/octo/repo", "label": "repo"},
		"cost": 2.5, "tokens": 100, "duration": 60, "errorCount": 0, "warningCount": 0,
	}
	var visit func(any)
	visit = func(value any) {
		if mapping := engineMap(value); mapping != nil {
			for key, value := range mapping {
				switch key {
				case "field", "left", "right", "time", "series", "definitions", "group":
					if field := engineString(value); field != "" {
						if _, ok := row[field]; !ok {
							row[field] = 2
						}
					}
				}
				visit(value)
			}
		} else {
			for _, value := range engineList(value) {
				visit(value)
			}
		}
	}
	visit(def)
	// A single row per source makes every declared equality join bounded.
	for _, item := range engineList(def["joins"]) {
		for _, item := range engineList(engineMap(item)["on"]) {
			pair := engineMap(item)
			row[engineString(pair["left"])] = "identity"
			row[engineString(pair["right"])] = "identity"
		}
	}
	return row
}
