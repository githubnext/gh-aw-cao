package server

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// bindParameters resolves operands only in the named query's dependency graph.
// Definitions owned by the application remain untouched between MCP calls.
func (runtime *mcpRuntime) bindParameters(id string, entry agentQuery, input any) ([]query.Definition, []query.Predicate, map[string]any, error) {
	definitions := runtime.app.config.DashboardQueries
	order, err := query.Dependencies(definitions, []string{id})
	if err != nil {
		return nil, nil, nil, err
	}
	declared := map[string]queryParameter{}
	for _, parameter := range entry.Parameters {
		declared[parameter.Name] = parameter
	}
	for _, name := range order {
		if catalogEntry, ok := runtime.findQuery(name); ok {
			for _, parameter := range catalogEntry.Parameters {
				if previous, exists := declared[parameter.Name]; exists {
					if previous.Type != parameter.Type || previous.Field != parameter.Field {
						return nil, nil, nil, fmt.Errorf("conflicting declaration for parameter %q", parameter.Name)
					}
					continue
				}
				if parameter.Name == "" {
					return nil, nil, nil, fmt.Errorf("conflicting declaration for parameter %q", parameter.Name)
				}
				declared[parameter.Name] = parameter
			}
		}
	}
	parameters := map[string]any{}
	if input != nil {
		var ok bool
		parameters, ok = input.(map[string]any)
		if !ok {
			return nil, nil, nil, errors.New("cao_query parameters must be an object")
		}
	}
	if len(parameters) > runtime.contract.Limits.MaxParameters || len(declared) > runtime.contract.Limits.MaxParameters {
		return nil, nil, nil, fmt.Errorf("At most %d query parameters are accepted", runtime.contract.Limits.MaxParameters)
	}
	resolved := map[string]any{}
	for name := range parameters {
		if _, ok := declared[name]; !ok {
			known := make([]string, 0, len(declared))
			for candidate := range declared {
				known = append(known, candidate)
			}
			slices.Sort(known)
			label := strings.Join(known, ", ")
			if label == "" {
				label = "none"
			}
			return nil, nil, nil, fmt.Errorf("Unknown parameter %q for query %s; declared parameters: %s", name, id, label)
		}
	}
	filters := []query.Predicate{}
	for name, parameter := range declared {
		raw, supplied := parameters[name]
		if !supplied {
			if parameter.Required || parameter.Type != "" {
				return nil, nil, nil, fmt.Errorf("Missing required parameter %q", name)
			}
			continue
		}
		var value any
		switch parameter.Type {
		case "number":
			number, ok := raw.(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) ||
				(parameter.Schema.Minimum != nil && (math.IsNaN(*parameter.Schema.Minimum) || math.IsInf(*parameter.Schema.Minimum, 0) || number < *parameter.Schema.Minimum)) ||
				(parameter.Schema.Maximum != nil && (math.IsNaN(*parameter.Schema.Maximum) || math.IsInf(*parameter.Schema.Maximum, 0) || number > *parameter.Schema.Maximum)) ||
				(parameter.Schema.Minimum != nil && parameter.Schema.Maximum != nil && *parameter.Schema.Minimum > *parameter.Schema.Maximum) {
				return nil, nil, nil, fmt.Errorf("Parameter %q must be a finite number within its declared range", name)
			}
			if step := parameter.Schema.MultipleOf; step != nil {
				quotient := number / *step
				if math.IsNaN(*step) || math.IsInf(*step, 0) || *step <= 0 || math.Abs(quotient-math.Round(quotient)) > 1e-9 {
					return nil, nil, nil, fmt.Errorf("Parameter %q must match its declared step", name)
				}
			}
			value = number
		case "string":
			text, ok := raw.(string)
			if !ok || len(text) > runtime.contract.Limits.MaxParameterLength {
				return nil, nil, nil, fmt.Errorf("Parameter %q must be a bounded string", name)
			}
			value = text
		case "boolean":
			boolean, ok := raw.(bool)
			if !ok {
				return nil, nil, nil, fmt.Errorf("Parameter %q must be a boolean", name)
			}
			value = boolean
		case "":
			switch raw.(type) {
			case string, float64, bool:
				value = fmt.Sprint(raw)
			default:
				return nil, nil, nil, fmt.Errorf("Parameter %q must be a string, number, or boolean", name)
			}
			if len(value.(string)) > runtime.contract.Limits.MaxParameterLength {
				return nil, nil, nil, fmt.Errorf("Parameter %q exceeds %d characters", name, runtime.contract.Limits.MaxParameterLength)
			}
		default:
			return nil, nil, nil, fmt.Errorf("Unsupported parameter type for %q", name)
		}
		if parameter.Schema.Enum != nil && !slices.ContainsFunc(parameter.Schema.Enum, func(candidate any) bool {
			switch parameter.Type {
			case "number":
				item, ok := candidate.(float64)
				return ok && item == value
			case "boolean":
				item, ok := candidate.(bool)
				return ok && item == value
			case "string":
				item, ok := candidate.(string)
				return ok && item == value
			default:
				return false
			}
		}) {
			return nil, nil, nil, fmt.Errorf("Parameter %q must match its declared enum", name)
		}
		resolved[name] = value
		if parameter.Field != "" && supplied {
			filters = append(filters, query.Predicate{Field: parameter.Field, Equals: value})
		}
	}

	bound := slices.Clone(definitions)
	reachable := make(map[string]bool, len(order))
	for _, name := range order {
		reachable[name] = true
	}
	for i, definition := range definitions {
		if !reachable[definition.Name] {
			continue
		}
		bound[i].Compute = slices.Clone(definition.Compute)
		for j, computed := range definition.Compute {
			bound[i].Compute[j].Args = slices.Clone(computed.Args)
			for k, argument := range computed.Args {
				if argument.Parameter == "" {
					continue
				}
				value, ok := resolved[argument.Parameter]
				if !ok || declared[argument.Parameter].Type == "" {
					return nil, nil, nil, fmt.Errorf("Missing or invalid operand parameter %q", argument.Parameter)
				}
				bound[i].Compute[j].Args[k] = query.Argument{Value: value}
			}
		}
		if definition.Filter != nil {
			filter, err := bindPredicateFilter(definition.Filter, resolved)
			if err != nil {
				return nil, nil, nil, err
			}
			bound[i].Filter = filter
		}
		if definition.Aggregate != nil {
			aggregate := *definition.Aggregate
			aggregate.Values = slices.Clone(definition.Aggregate.Values)
			for j, value := range aggregate.Values {
				if value.Filter != nil {
					filter, err := bindPredicateFilter(value.Filter, resolved)
					if err != nil {
						return nil, nil, nil, err
					}
					aggregate.Values[j].Filter = filter
				}
			}
			bound[i].Aggregate = &aggregate
		}
	}
	return bound, filters, resolved, nil
}

func bindPredicateFilter(original *query.Filter, values map[string]any) (*query.Filter, error) {
	filter := *original
	filter.Predicates = slices.Clone(original.Predicates)
	for i, predicate := range original.Predicates {
		var err error
		filter.Predicates[i].Equals, err = bindPredicateOperand(predicate.Equals, values)
		if err != nil {
			return nil, err
		}
		filter.Predicates[i].GTE, err = bindPredicateOperand(predicate.GTE, values)
		if err != nil {
			return nil, err
		}
		filter.Predicates[i].LT, err = bindPredicateOperand(predicate.LT, values)
		if err != nil {
			return nil, err
		}
		filter.Predicates[i].In = slices.Clone(predicate.In)
		for j, operand := range predicate.In {
			filter.Predicates[i].In[j], err = bindPredicateOperand(operand, values)
			if err != nil {
				return nil, err
			}
		}
	}
	return &filter, nil
}

func bindPredicateOperand(operand any, values map[string]any) (any, error) {
	reference, ok := operand.(map[string]any)
	if !ok {
		return operand, nil
	}
	name, valid := reference["parameter"].(string)
	if !valid || len(reference) != 1 || name == "" {
		return nil, errors.New("Unsupported predicate operand")
	}
	value, exists := values[name]
	if !exists {
		return nil, fmt.Errorf("Missing operand parameter %q", name)
	}
	return value, nil
}
