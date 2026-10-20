package dashboardquery

import (
	"reflect"
	"strings"
	"testing"
)

func TestEvaluatorOwnsRowsAcrossMaterializationStages(t *testing.T) {
	join := []any{map[string]any{
		"source": "right", "type": "left",
		"on":     []any{map[string]any{"left": "id", "right": "id"}},
		"fields": []any{map[string]any{"field": "value", "as": "joined"}},
	}}
	compute := []any{map[string]any{
		"as": "value", "function": "product",
		"args": []any{map[string]any{"field": "value"}, map[string]any{"value": 2}},
	}}
	for name, stages := range map[string]map[string]any{
		"raw":          {},
		"filter":       {"filter": map[string]any{"predicates": []any{map[string]any{"field": "value", "gte": 2}}}},
		"join":         {"joins": join},
		"compute":      {"compute": compute},
		"join-compute": {"joins": join, "compute": compute},
		"select":       {"select": []any{map[string]any{"field": "value"}}},
		"aggregate": {"aggregate": map[string]any{
			"by": []any{}, "values": []any{map[string]any{"field": "value", "as": "total", "reducer": "sum"}},
		}},
	} {
		t.Run(name, func(t *testing.T) {
			source := []map[string]any{{"id": "one", "value": 2}, {"id": "two", "value": 3}}
			before := []map[string]any{engineClone(source[0]), engineClone(source[1])}
			definition := map[string]any{"name": "result", "from": "input"}
			for key, value := range stages {
				definition[key] = value
			}
			result, err := NewEvaluator(t.Context()).Execute(definition, func(input string) ([]map[string]any, error) {
				if input == "right" {
					return []map[string]any{{"id": "one", "value": 10}}, nil
				}
				return source, nil
			})
			if err != nil || len(result) == 0 {
				t.Fatalf("execute: rows=%v error=%v", result, err)
			}
			result[0]["value"] = 999
			if !reflect.DeepEqual(source, before) {
				t.Fatalf("execution or result mutation changed borrowed rows: %v", source)
			}
			if len(result) > 1 && result[1]["value"] == 999 {
				t.Fatal("result rows share a mutable map")
			}
		})
	}
}

func TestEvaluatorBoundsIntermediatesWithoutChangingCLIOutputLimit(t *testing.T) {
	rows := make([]map[string]any, engineMaxOutputRows+1)
	for index := range rows {
		rows[index] = map[string]any{"id": index}
	}

	loader := func(string) ([]map[string]any, error) { return rows, nil }
	definition := map[string]any{"name": "intermediate", "from": "input"}
	result, err := NewEvaluator(t.Context()).Execute(definition, loader)
	if err != nil || len(result) != len(rows) {
		t.Fatalf("bounded intermediate was rejected: rows=%d err=%v", len(result), err)
	}
	if _, err := Execute(t.Context(), definition, loader); err == nil || !strings.Contains(err.Error(), "max-output-rows") {
		t.Fatalf("CLI output limit changed: %v", err)
	}
}

func TestSnapshotEvaluatorHasIndependentBoundedLimits(t *testing.T) {
	rows := make([]map[string]any, engineMaxInputRows+1)
	for index := range rows {
		rows[index] = map[string]any{"value": 1}
	}
	loader := func(string) ([]map[string]any, error) { return rows, nil }
	definition := map[string]any{
		"name": "count", "from": "input",
		"aggregate": map[string]any{"by": []any{}, "values": []any{
			map[string]any{"field": "value", "as": "count", "reducer": "count"},
		}},
	}
	if _, err := NewEvaluator(t.Context()).Execute(definition, loader); err == nil || !strings.Contains(err.Error(), "max-input-rows") {
		t.Fatalf("default input limit changed: %v", err)
	}
	evaluator, err := NewEvaluatorWithLimits(t.Context(), 500_000, 50_000_000)
	if err != nil {
		t.Fatal(err)
	}
	result, err := evaluator.Execute(definition, loader)
	if err != nil || len(result) != 1 || result[0]["count"] != len(rows) {
		t.Fatalf("larger snapshot was not aggregated: %v, %v", result, err)
	}
	if _, err := evaluator.Execute(definition, func(string) ([]map[string]any, error) {
		return make([]map[string]any, 500_001), nil
	}); err == nil || !strings.Contains(err.Error(), "500000") {
		t.Fatalf("snapshot input limit was not enforced: %v", err)
	}
	limited, err := NewEvaluatorWithLimits(t.Context(), 500_000, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := limited.Execute(definition, loader); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("snapshot operation limit was not enforced: %v", err)
	}
	for _, limits := range [][2]int{{0, 1}, {1, 0}, {1_000_001, 1}, {1, 100_000_001}} {
		if _, err := NewEvaluatorWithLimits(t.Context(), limits[0], int64(limits[1])); err == nil {
			t.Fatalf("unsafe limits accepted: %v", limits)
		}
	}
}
