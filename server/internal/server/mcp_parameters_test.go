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
	if _, _, _, err := runtime.bindParameters(final.Name, runtime.catalog.Queries[1], nil); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing operand: %v", err)
	}
}

func stringPointer(value string) *string { return &value }

func TestResolveParameterValue(t *testing.T) {
	min, max, step := float64(2), float64(10), float64(2)
	numberParameter := queryParameter{Type: "number"}
	numberParameter.Schema.Minimum, numberParameter.Schema.Maximum, numberParameter.Schema.MultipleOf = &min, &max, &step
	invertedParameter := queryParameter{Type: "number"}
	invertedMin, invertedMax := float64(10), float64(2)
	invertedParameter.Schema.Minimum, invertedParameter.Schema.Maximum = &invertedMin, &invertedMax

	for _, test := range []struct {
		name         string
		parameter    queryParameter
		raw          any
		maxLength    int
		wantValue    any
		wantReason   parameterRejectionReason
		wantRejected bool
	}{
		{"number within bounds and step", numberParameter, float64(6), 0, float64(6), parameterRejectionNone, false},
		{"number below minimum", numberParameter, float64(1), 0, nil, parameterRejectionInvalidNumber, true},
		{"number above maximum", numberParameter, float64(11), 0, nil, parameterRejectionInvalidNumber, true},
		{"number not finite", numberParameter, math.Inf(1), 0, nil, parameterRejectionInvalidNumber, true},
		{"number wrong go type", numberParameter, "6", 0, nil, parameterRejectionInvalidNumber, true},
		{"number violates step", numberParameter, float64(7), 0, nil, parameterRejectionInvalidStep, true},
		{"number inverted range always rejects", invertedParameter, float64(5), 0, nil, parameterRejectionInvalidNumber, true},
		{"string within bound", queryParameter{Type: "string"}, "abc", 5, "abc", parameterRejectionNone, false},
		{"string exceeds bound", queryParameter{Type: "string"}, "abcdef", 5, nil, parameterRejectionWrongType, true},
		{"string wrong go type", queryParameter{Type: "string"}, float64(1), 5, nil, parameterRejectionWrongType, true},
		{"boolean accepted", queryParameter{Type: "boolean"}, true, 0, true, parameterRejectionNone, false},
		{"boolean wrong go type", queryParameter{Type: "boolean"}, "true", 0, nil, parameterRejectionWrongType, true},
		{"untyped string coerced", queryParameter{}, "x", 5, "x", parameterRejectionNone, false},
		{"untyped number coerced", queryParameter{}, float64(5), 5, "5", parameterRejectionNone, false},
		{"untyped exceeds bound", queryParameter{}, "abcdef", 5, nil, parameterRejectionWrongType, true},
		{"untyped unsupported go type", queryParameter{}, []any{1}, 5, nil, parameterRejectionWrongType, true},
		{"unsupported declared type", queryParameter{Type: "object"}, "x", 5, nil, parameterRejectionWrongType, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, reason, err := resolveParameterValue("p", test.parameter, test.raw, test.maxLength)
			if (err != nil) != test.wantRejected {
				t.Fatalf("resolveParameterValue() error = %v, want rejected %t", err, test.wantRejected)
			}
			if reason != test.wantReason {
				t.Fatalf("resolveParameterValue() reason = %q, want %q", reason, test.wantReason)
			}
			if !test.wantRejected && value != test.wantValue {
				t.Fatalf("resolveParameterValue() value = %v, want %v", value, test.wantValue)
			}
		})
	}
}

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
	app.database = integrationDatabase(t)
	seedDatabase(t, app.database, map[string]model.Source{})
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
			"id": "simulator-database-summary", "parameters": params,
		})
		if err != nil {
			t.Fatal(err)
		}
		rows := payload.(map[string]any)["rows"].([]model.Row)
		if len(rows) != 4 {
			t.Fatalf("got %d simulator rows, want 4", len(rows))
		}
		runBytes := params["repositories"].(float64) * params["runs-per-day"].(float64) * 30 * 512
		activeRuns := params["repositories"].(float64) * params["runs-per-day"].(float64) * 30 * (1 - params["skip-rate"].(float64)/100)
		toolBytes := activeRuns * params["tools-per-run"].(float64) * 256
		issueBytes := activeRuns * params["issues-per-run"].(float64) * 512
		want := map[string]float64{
			"Run summaries":       runBytes,
			"Tools (30-day TTL)":  toolBytes,
			"Issues (30-day TTL)": issueBytes,
			"Total":               runBytes + toolBytes + issueBytes,
		}
		for _, row := range rows {
			numeric, valid := row["bytes"].(json.Number)
			value, _ := numeric.Float64()
			table, ok := row["table"].(string)
			expected, known := want[table]
			if !valid || !ok || !known || value != expected {
				t.Fatalf("unexpected simulator row: %+v, want %v", row, want)
			}
			delete(want, table)
		}
		if len(want) != 0 {
			t.Fatalf("missing simulator tables: %v", want)
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
