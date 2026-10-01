package server

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type simulationLoader struct{}

func (simulationLoader) LoadSource(name string, _ *query.Definition) (model.Source, model.Metrics, error) {
	return simulationDaysSource(), model.Metrics{}, nil
}

func TestMCPBindsSimulatorOperandsInDependencies(t *testing.T) {
	min, max, defaultValue, step := float64(1), float64(100000), float64(1000), float64(1)
	input := query.Definition{
		Name: "simulator-database-inputs", From: "simulation-days",
		Compute: []query.ComputedField{{
			As: "runs-daily", Function: "product",
			Args: []query.Argument{{Parameter: "repositories"}, {Value: float64(10)}},
		}},
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "day", LT: map[string]any{"parameter": "repositories"}}}},
	}

	final := query.Definition{Name: "simulator-database-size", From: input.Name,
		Compute: []query.ComputedField{{As: "bytes", Function: "product", Args: []query.Argument{
			{Field: stringPointer("runs-daily")}, {Value: float64(512)},
		}}},
	}
	parameter := queryParameter{Name: "repositories", Type: "number", Required: true}
	parameter.Schema.Minimum, parameter.Schema.Maximum, parameter.Schema.Default = &min, &max, &defaultValue
	parameter.Schema.MultipleOf = &step
	runtime := &mcpRuntime{
		app: &App{config: Config{DashboardQueries: []query.Definition{input, final}}},
		catalog: agentCatalog{Queries: []agentQuery{
			{ID: input.Name, Parameters: []queryParameter{parameter}},
			{ID: final.Name},
		}},
	}
	runtime.contract.Limits.MaxParameters = 8
	runtime.contract.Limits.MaxParameterLength = 128
	for _, test := range []struct {
		name       string
		parameters any
		want       float64
	}{
		{"explicit", map[string]any{"repositories": float64(7)}, 7},
	} {
		t.Run(test.name, func(t *testing.T) {
			definitions, filters, resolved, err := runtime.bindParameters(final.Name, runtime.catalog.Queries[1], test.parameters)
			if err != nil {
				t.Fatal(err)
			}
			if len(filters) != 0 || resolved["repositories"] != test.want {
				t.Fatalf("filters=%v resolved=%v", filters, resolved)
			}
			bound := definitions[0]
			if bound.Compute[0].Args[0].Value != test.want || bound.Filter.Predicates[0].LT != test.want {
				t.Fatalf("unbound operands: %+v", bound)
			}
			if input.Compute[0].Args[0].Parameter != "repositories" {
				t.Fatal("shared query was modified")
			}
			rows, _, err := query.New(simulationLoader{}).Execute(definitions, []string{final.Name})
			if err != nil {
				t.Fatal(err)
			}
			if len(rows[final.Name].Rows) == 0 || rows[final.Name].Rows[0]["bytes"] != test.want*10*512 {
				t.Fatalf("simulator result: %+v", rows[final.Name])
			}
		})
	}
	for _, test := range []struct {
		name string
		raw  any
	}{
		{"unknown", map[string]any{"bogus": float64(2)}},
		{"non-numeric", map[string]any{"repositories": "2"}},
		{"nonfinite", map[string]any{"repositories": math.Inf(1)}},
		{"below minimum", map[string]any{"repositories": float64(0)}},
		{"above maximum", map[string]any{"repositories": float64(100001)}},
		{"invalid step", map[string]any{"repositories": float64(1.5)}},
		{"null", map[string]any{"repositories": nil}},
		{"malformed object", []any{1}},
		{"omitted required parameter", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, _, err := runtime.bindParameters(final.Name, runtime.catalog.Queries[1], test.raw); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
	if _, _, _, err := runtime.bindParameters(final.Name, runtime.catalog.Queries[1], nil); err == nil || !strings.Contains(err.Error(), "Missing") {
		t.Fatalf("missing operand: %v", err)
	}
}

func stringPointer(value string) *string { return &value }

func TestMCPDecodesParameterizedComputeOperand(t *testing.T) {
	var definition query.Definition
	if err := json.Unmarshal([]byte(`{"name":"simulator-database-inputs","from":"simulation-days","compute":[{"as":"daily","function":"literal","args":[{"parameter":"repositories"}]}]}`), &definition); err != nil {
		t.Fatal(err)
	}
	if definition.Compute[0].Args[0].Parameter != "repositories" {
		t.Fatalf("lost parameter reference: %+v", definition.Compute[0].Args[0])
	}
}

func TestMCPExecutesGeneratedSimulatorQuery(t *testing.T) {
	app := newMCPTestApp(t, true)
	catalog, err := readJSONFile[agentCatalog](testAgentCatalog)
	if err != nil {
		t.Fatal(err)
	}

	runtime := &mcpRuntime{app: app, catalog: catalog}
	runtime.contract.Limits.MaxParameters = 16
	runtime.contract.Limits.MaxParameterLength = 256
	runtime.contract.Limits.DefaultQueryRows = 100
	runtime.contract.Limits.MaxQueryRows = 5000
	for _, params := range []map[string]any{
		{"repositories": float64(1000), "runs-per-day": float64(10), "skip-rate": float64(20), "tools-per-run": float64(10), "issues-per-run": float64(1)},
		{"repositories": float64(2), "runs-per-day": float64(3), "skip-rate": float64(20), "tools-per-run": float64(10), "issues-per-run": float64(1)},
	} {
		payload, err := runtime.callQuery(context.Background(), map[string]any{
			"id": "simulator-database-size", "parameters": params,
		})
		if err != nil {
			t.Fatal(err)
		}
		rows := payload.(map[string]any)["rows"].([]model.Row)
		if len(rows) != 90 {
			t.Fatalf("got %d simulator rows, want 90", len(rows))
		}
		firstRun := params["repositories"].(float64) * params["runs-per-day"].(float64) * 512
		found := false
		for _, row := range rows {
			if row["table"] == "Run summaries" && row["date"] == rows[0]["date"] && row["bytes"] == firstRun {
				found = true
			}
		}
		if !found {
			t.Fatalf("simulator did not compute expected run summary %v", firstRun)
		}
	}
}

func TestMCPParameterOptionalBoundsAndEnums(t *testing.T) {
	for _, test := range []struct {
		name   string
		schema string
		value  any
		valid  bool
	}{
		{"number without bounds", `{"type":"number","default":3}`, float64(123), true},
		{"finite number required", `{"type":"number"}`, math.NaN(), false},
		{"minimum only accepts", `{"type":"number","minimum":2}`, float64(20), true},
		{"minimum only rejects", `{"type":"number","minimum":2}`, float64(1), false},
		{"maximum only accepts", `{"type":"number","maximum":5}`, float64(-20), true},
		{"maximum only rejects", `{"type":"number","maximum":5}`, float64(6), false},
		{"number enum accepts", `{"type":"number","enum":[1,3,5]}`, float64(3), true},
		{"number enum rejects", `{"type":"number","enum":[1,3,5]}`, float64(2), false},
		{"string enum accepts", `{"type":"string","enum":["small","large"],"default":"small"}`, "large", true},
		{"string enum rejects", `{"type":"string","enum":["small","large"]}`, "medium", false},
		{"boolean enum accepts", `{"type":"boolean","enum":[true],"default":true}`, true, true},
		{"boolean enum rejects", `{"type":"boolean","enum":[true]}`, false, false},
		{"empty enum rejects", `{"type":"string","enum":[]}`, "anything", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var parameter queryParameter
			if err := json.Unmarshal([]byte(`{"name":"choice","required":true,"schema":`+test.schema+`}`), &parameter); err != nil {
				t.Fatal(err)
			}
			var specification struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal([]byte(test.schema), &specification); err != nil {
				t.Fatal(err)
			}
			parameter.Type = specification.Type
			entry := agentQuery{ID: "operand", Parameters: []queryParameter{parameter}}
			runtime := &mcpRuntime{
				app: &App{config: Config{DashboardQueries: []query.Definition{{
					Name: "operand", From: "simulation-days",
					Compute: []query.ComputedField{{As: "choice", Function: "literal", Args: []query.Argument{{Parameter: "choice"}}}},
				}}}},
				catalog: agentCatalog{Queries: []agentQuery{entry}},
			}
			runtime.contract.Limits.MaxParameters = 8
			runtime.contract.Limits.MaxParameterLength = 128
			definitions, _, _, err := runtime.bindParameters(entry.ID, entry, map[string]any{"choice": test.value})
			if (err == nil) != test.valid {
				t.Fatalf("bindParameters() error = %v, want valid %t", err, test.valid)
			}
			if test.valid && definitions[0].Compute[0].Args[0].Value != test.value {
				t.Fatalf("resolved value = %v, want %v", definitions[0].Compute[0].Args[0].Value, test.value)
			}
			if _, _, _, err := runtime.bindParameters(entry.ID, entry, nil); err == nil {
				t.Fatal("missing explicitly required operand accepted")
			}
		})
	}
}
