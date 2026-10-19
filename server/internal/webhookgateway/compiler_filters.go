package webhookgateway

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
)

func validCompilerFilterName(name string) bool {
	for _, segment := range strings.Split(name, ".") {
		if segment != "*" && !genericProperty.MatchString(segment) ||
			slices.Contains([]string{"__proto__", "prototype", "constructor"}, segment) {
			return false
		}
	}
	return true
}

func conditionOperands(condition CompilerCondition) []any {
	var result []any
	for _, raw := range condition.Values {
		value, err := boundedJSON(raw, DefaultLimits().MaxMetadataBytes, DefaultLimits())
		if err != nil {
			return nil
		}
		result = append(result, value)
	}
	return result
}

func scalarKey(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func matchingLiterals(value any, path []string, accepted []any, result map[string]any) {
	if len(path) == 0 {
		for _, literal := range accepted {
			if same, comparable := equal(value, literal); comparable && same {
				result[scalarKey(literal)] = literal
			}
		}
		return
	}
	if path[0] == "*" {
		items, _ := value.([]any)
		for _, item := range items {
			matchingLiterals(item, path[1:], accepted, result)
		}
		return
	}
	object, _ := value.(map[string]any)
	matchingLiterals(object[path[0]], path[1:], accepted, result)
}

func compilerConditionGroups(t CompilerTrigger) [][]CompilerCondition {
	if t.AnyOf == nil {
		return [][]CompilerCondition{t.Conditions}
	}
	groups := make([][]CompilerCondition, 0, len(t.AnyOf))
	for _, group := range t.AnyOf {
		groups = append(groups, append(slices.Clone(t.Conditions), group...))
	}
	return groups
}

func projectCompilerFilters(t CompilerTrigger, root any) (map[string]any, error) {
	for _, conditions := range compilerConditionGroups(t) {
		filters := make(map[string]map[string]any)
		for _, condition := range conditions {
			found := make(map[string]any)
			matchingLiterals(root, condition.Path, conditionOperands(condition), found)
			if previous, exists := filters[condition.Filter]; exists {
				for key := range found {
					if _, exists := previous[key]; !exists {
						delete(found, key)
					}
				}
			}
			filters[condition.Filter] = found
		}
		result := make(map[string]any)
		matched := true
		for name, values := range filters {
			if len(values) == 0 {
				matched = false
				break
			}
			keys := slices.Sorted(maps.Keys(values))
			scalars := make([]any, 0, len(keys))
			for _, key := range keys {
				scalars = append(scalars, values[key])
			}
			result[name] = scalars
		}
		if matched {
			return result, nil
		}
	}
	return nil, ErrInvalid
}

func addCompilerFilters(payload map[string]any, trigger CompilerTrigger, root any) error {
	filters, err := projectCompilerFilters(trigger, root)
	if err != nil {
		return err
	}
	if len(filters) != 0 {
		payload["filters"] = filters
	}
	return nil
}

func validCompilerFilters(trigger CompilerTrigger, payload map[string]any) bool {
	for name := range payload {
		if name != "url" && name != "type" && name != "filters" {
			return false
		}
	}
	raw, present := payload["filters"]
	projected, ok := raw.(map[string]any)
	if present && (!ok || len(projected) == 0) {
		return false
	}
	for _, conditions := range compilerConditionGroups(trigger) {
		names := make(map[string]bool)
		valid := true
		for _, condition := range conditions {
			names[condition.Filter] = true
			values, ok := projected[condition.Filter].([]any)
			if !ok || len(values) == 0 {
				valid = false
				break
			}
			seen := make(map[string]bool)
			accepted := conditionOperands(condition)
			for _, value := range values {
				key := scalarKey(value)
				if seen[key] || !slices.ContainsFunc(accepted, func(literal any) bool {
					same, comparable := equal(value, literal)
					return comparable && same
				}) {
					valid = false
					break
				}
				seen[key] = true
			}
		}
		if valid && len(projected) == len(names) {
			return true
		}
	}
	return false
}
