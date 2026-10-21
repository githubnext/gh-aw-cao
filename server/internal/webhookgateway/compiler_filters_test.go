package webhookgateway

import (
	"encoding/json"
	"reflect"
	"testing"
)

func stringCondition(name string, path []string, values ...string) CompilerCondition {
	condition := CompilerCondition{Filter: name, Path: path, Operator: "equals", ValueType: "string"}
	for _, value := range values {
		raw, _ := json.Marshal(value)
		condition.Values = append(condition.Values, raw)
	}
	return condition
}

func TestCompilerFilterProjectionIncludesOnlyObservedMatchingLiterals(t *testing.T) {
	trigger := CompilerTrigger{Conditions: []CompilerCondition{
		stringCondition("labels", []string{"labels", "*"}, "accepted", "absent"),
	}}
	root := map[string]any{"labels": []any{"unselected", "accepted", "accepted"}, "title": "MUST-NOT-PERSIST"}
	filters, err := projectCompilerFilters(trigger, root)
	if err != nil || !reflect.DeepEqual(filters, map[string]any{"labels": []any{"accepted"}}) {
		t.Fatal("projection retained unobserved/unselected values", filters, err)
	}
	payload := map[string]any{"url": "https://example.com/resource", "type": []any{"edited"}, "filters": filters}
	if !validCompilerFilters(trigger, payload) {
		t.Fatal("valid matching filter evidence rejected")
	}
	for _, invalid := range []any{
		nil, map[string]any{}, map[string]any{"labels": []any{}},
		map[string]any{"labels": []any{"unselected"}},
		map[string]any{"labels": []any{"accepted", "accepted"}},
		map[string]any{"labels": []any{"accepted", true}},
		map[string]any{"labels": []any{map[string]any{"name": "accepted"}}},
		map[string]any{"labels": []any{"accepted"}, "title": []any{"forbidden"}},
	} {
		payload["filters"] = invalid
		if validCompilerFilters(trigger, payload) {
			t.Fatal("invalid/nested filter evidence accepted", invalid)
		}
	}
	delete(payload, "filters")
	if validCompilerFilters(trigger, payload) {
		t.Fatal("required filter evidence omitted")
	}
	trigger.Conditions = nil
	if !validCompilerFilters(trigger, payload) {
		t.Fatal("predicate-free declaration needs no filters")
	}
	payload["filters"] = filters
	if validCompilerFilters(trigger, payload) {
		t.Fatal("predicate-free declaration accepted additional data")
	}
}

func TestCompilerFilterProjectionKeepsCompleteTransitionAlternatives(t *testing.T) {
	trigger := CompilerTrigger{Conditions: []CompilerCondition{
		stringCondition("project_id", []string{"project"}, "PVT_example"),
	}, AnyOf: [][]CompilerCondition{
		{stringCondition("status.from", []string{"change", "from"}, "Open"), stringCondition("status.to", []string{"change", "to"}, "Active")},
		{stringCondition("status.from", []string{"change", "from"}, "Active"), stringCondition("status.to", []string{"change", "to"}, "Done")},
	}}
	for _, transition := range [][]string{{"Open", "Active"}, {"Active", "Done"}, {"Open", "Done"}} {
		root := map[string]any{"project": "PVT_example", "change": map[string]any{"from": transition[0], "to": transition[1]}}
		filters, err := projectCompilerFilters(trigger, root)
		if transition[0] == "Open" && transition[1] == "Done" {
			if err == nil {
				t.Fatal("cross-combined transition was projected")
			}
			continue
		}
		if err != nil || !validCompilerFilters(trigger, map[string]any{"filters": filters}) {
			t.Fatal("complete matching transition rejected", filters, err)
		}
		filters["status.from"] = []any{"Open"}
		filters["status.to"] = []any{"Done"}
		if validCompilerFilters(trigger, map[string]any{"filters": filters}) {
			t.Fatal("cross-combined projected transition accepted")
		}
	}
	trigger.AnyOf = nil
	trigger.Conditions = append(trigger.Conditions,
		stringCondition("shared", []string{"left"}, "a", "b"),
		stringCondition("shared", []string{"right"}, "a", "b"))
	root := map[string]any{"project": "PVT_example", "left": "a", "right": "b"}
	if _, err := projectCompilerFilters(trigger, root); err == nil {
		t.Fatal("duplicate filter name fabricated a common observed value")
	}
}
