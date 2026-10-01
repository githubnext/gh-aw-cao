package redisx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

var nativeQueryField = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

func (s *Store) ExecutePlan(
	ctx context.Context,
	generation string,
	definitions []query.Definition,
	requested, _ []string,
	external map[string]model.Source,
) (map[string]model.Source, model.Metrics, error) {
	if len(external) != 0 || len(definitions) != 1 || len(requested) != 1 || requested[0] != definitions[0].Name {
		return nil, model.Metrics{}, errors.New("redis query engine requires one direct-source query")
	}
	definition := definitions[0]
	metrics := model.Metrics{RedisCommands: 1}
	metadata, err := s.sourceInfo(ctx, generation, definition.From)
	if err != nil {
		return nil, metrics, err
	}
	format, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "source:"+definition.From+":format")
	metrics.RedisCommands++
	if err != nil {
		return nil, metrics, err
	}
	if fmt.Sprint(format) != "json" {
		return nil, metrics, errors.New("redis query engine requires a JSON source")
	}
	fields, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "source:"+definition.From+":index-schema")
	metrics.RedisCommands++
	if err != nil {
		return nil, metrics, err
	}
	var indexed []indexField
	if fields != nil {
		if err := json.Unmarshal([]byte(fmt.Sprint(fields)), &indexed); err != nil {
			return nil, metrics, err
		}
	} else {
		legacy, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "source:"+definition.From+":indexed-fields")
		metrics.RedisCommands++
		if err != nil {
			return nil, metrics, err
		}
		var names []string
		if legacy != nil {
			if err := json.Unmarshal([]byte(fmt.Sprint(legacy)), &names); err != nil {
				return nil, metrics, err
			}
		}
		for _, name := range names {
			indexed = append(indexed, indexField{Name: name, Alias: nativeFieldAlias(name), Kind: indexFieldTag})
		}
	}
	command, outputFields, err := nativeAggregateCommand(s.sourceIndexKey(generation, definition.From), definition, indexed)
	if err != nil {
		return nil, metrics, err
	}
	value, err := s.Client.Do(ctx, command...)
	metrics.RedisCommands++
	if err != nil {
		return nil, metrics, fmt.Errorf("execute FT.AGGREGATE query plan: %w", err)
	}
	rows, err := decodeAggregateRows(value, outputFields)
	if err != nil {
		return nil, metrics, err
	}
	metadata["source-id"] = definition.Name
	metadata["source-kind"] = "database-query"
	metadata["availability"] = "available"
	if len(rows) == 0 {
		metadata["availability"] = "empty"
	}
	metadata["row-count"] = len(rows)
	metrics.PushedDown = []string{"redis-query-engine"}
	metrics.QueryCount = 1
	metrics.FilterCount = boolCount(definition.Filter != nil)
	metrics.ComputeCount = len(definition.Compute)
	metrics.AggregateCount = boolCount(definition.Aggregate != nil)
	metrics.SelectCount = len(definition.Select)
	metrics.OrderByCount = len(definition.OrderBy)
	metrics.LimitCount = boolCount(definition.Limit != nil)
	metrics.OutputRows = len(rows)
	metrics.RedisRows = len(rows)
	return map[string]model.Source{
		definition.Name: {Source: definition.Name, Rows: rows, Metadata: metadata},
	}, metrics, nil
}

// outputField describes how a Redis aggregate pipeline alias maps back to a
// Dashboard Language field name, and whether it was populated via a JSONPath
// LOAD. Under DIALECT 4 (required for TAG value escaping), LOAD returns
// JSONPath matches as a single-element array rather than unwrapping them, so
// decodeAggregateRows must know which aliases need unwrapping.
type outputField struct {
	name     string
	fromLoad bool
	numeric  bool
	boolean  bool
}

func nativeAggregateCommand(index string, definition query.Definition, indexed []indexField) ([]string, map[string]outputField, error) {
	if len(definition.Union) != 0 || len(definition.Joins) != 0 ||
		definition.TemporalSeries != nil || len(definition.Predict) != 0 || len(definition.Stores) != 0 ||
		len(definition.StoresBySource) != 0 {
		return nil, nil, errors.New("redis query engine does not support this query shape")
	}
	search, err := nativeSearchExpression(definition.Filter, indexed)
	if err != nil {
		return nil, nil, err
	}
	if len(definition.Select) == 0 {
		return nil, nil, errors.New("redis query engine requires an explicit projection")
	}
	computed := make(map[string]query.ComputedField, len(definition.Compute))
	for _, field := range definition.Compute {
		if !nativeQueryField.MatchString(field.As) {
			return nil, nil, fmt.Errorf("unsupported Redis computed field %q", field.As)
		}
		computed[field.As] = field
	}
	selected := make(map[string]bool, len(definition.Select))
	outputFields := make(map[string]outputField, len(definition.Select))
	command := []string{"FT.AGGREGATE", index, search}
	loads := make([]string, 0, len(definition.Select)*3)
	if definition.Aggregate == nil {
		for _, field := range definition.Select {
			if _, isComputed := computed[field.Field]; !isComputed {
				loads = append(loads, redisJSONPath(field.Field), "AS", nativeFieldAlias(field.Field))
			}
		}
		if len(loads) != 0 {
			command = append(command, "LOAD", strconv.Itoa(len(loads)))
			command = append(command, loads...)
		}
	}
	computedFields := make(map[string]indexField, len(definition.Compute))
	computedBooleans := make(map[string]bool, len(definition.Compute))
	for _, field := range definition.Compute {
		expression, result, boolean, err := nativeComputedExpression(field, indexed, computedFields)
		if err != nil {
			return nil, nil, fmt.Errorf("computed field %q: %w", field.As, err)
		}
		command = append(command, "APPLY", expression, "AS", nativeFieldAlias(field.As))
		computedFields[field.As] = result
		computedBooleans[field.As] = boolean
	}
	available := make(map[string]outputField)
	if definition.Aggregate != nil {
		group := make([]string, 0, len(definition.Aggregate.By))
		for _, name := range definition.Aggregate.By {
			field, ok := findPipelineField(indexed, computedFields, name)
			if !ok {
				return nil, nil, fmt.Errorf("redis grouping field %q is not indexed", name)
			}
			group = append(group, "@"+field.Alias)
			available[name] = outputField{
				name: name, numeric: field.Kind == indexFieldNumeric, boolean: computedBooleans[name],
			}
		}
		command = append(command, "GROUPBY", strconv.Itoa(len(group)))
		command = append(command, group...)
		for _, value := range definition.Aggregate.Values {
			field, ok := findPipelineField(indexed, computedFields, value.Field)
			if !ok || value.Filter != nil || !nativeQueryField.MatchString(value.As) {
				return nil, nil, fmt.Errorf("unsupported Redis reducer field %q", value.Field)
			}
			reducer, arguments, ok := nativeReducer(value.Reducer, field)
			if !ok {
				return nil, nil, fmt.Errorf("unsupported Redis reducer %q", value.Reducer)
			}
			command = append(command, "REDUCE", reducer, strconv.Itoa(len(arguments)))
			command = append(command, arguments...)
			alias := nativeFieldAlias(value.As)
			command = append(command, "AS", alias)
			available[value.As] = outputField{name: value.As, numeric: true}
		}
	}
	for _, field := range definition.Select {
		if !nativeQueryField.MatchString(field.Field) {
			return nil, nil, fmt.Errorf("unsupported Redis selected field %q", field.Field)
		}
		alias := nativeFieldAlias(field.Field)
		output := field.As
		if output == "" {
			output = field.Field
		}
		fromLoad := false
		numeric := false
		boolean := false
		if definition.Aggregate == nil {
			_, isComputed := computed[field.Field]
			fromLoad = !isComputed
			if computedField, ok := computedFields[field.Field]; ok {
				numeric = computedField.Kind == indexFieldNumeric
				boolean = computedBooleans[field.Field]
			}
		} else {
			availableField, ok := available[field.Field]
			if !ok {
				return nil, nil, fmt.Errorf("redis aggregate field %q is not available", field.Field)
			}
			numeric = availableField.numeric
			boolean = availableField.boolean
		}
		if previous, exists := outputFields[alias]; exists && previous.name != output {
			return nil, nil, fmt.Errorf("redis field alias collision for %q", field.Field)
		}
		outputFields[alias] = outputField{
			name: output, fromLoad: fromLoad, numeric: numeric, boolean: boolean,
		}
		selected[field.Field] = true
	}
	for _, field := range definition.OrderBy {
		if !selected[field.Field] {
			return nil, nil, fmt.Errorf("redis ordering field %q must be projected", field.Field)
		}
	}
	if len(definition.OrderBy) != 0 {
		order := make([]string, 0, len(definition.OrderBy)*2)
		for _, field := range definition.OrderBy {
			direction := "ASC"
			if field.Direction == "desc" {
				direction = "DESC"
			}
			order = append(order, "@"+nativeFieldAlias(field.Field), direction)
		}
		command = append(command, "SORTBY", strconv.Itoa(len(order)))
		command = append(command, order...)
		if definition.Limit != nil {
			command = append(command, "MAX", strconv.Itoa(*definition.Limit))
		}
	}
	limit := query.MaxOutputRows
	if definition.Limit != nil {
		limit = *definition.Limit
	}
	command = append(command, "LIMIT", "0", strconv.Itoa(limit), "DIALECT", "4")
	return command, outputFields, nil
}

func nativeSearchExpression(filter *query.Filter, indexed []indexField) (string, error) {
	if filter == nil {
		return "*", nil
	}
	parts := make([]string, 0, len(filter.Predicates)+1)
	if filter.Search != nil {
		return "", errors.New("redis text search does not preserve substring semantics")
	}
	for _, predicate := range filter.Predicates {
		field, indexed := findIndexField(indexed, predicate.Field)
		if predicate.Optional || predicate.Includes != "" || !indexed {
			return "", fmt.Errorf("unsupported Redis predicate for %q", predicate.Field)
		}
		if predicate.GTE != nil || predicate.LT != nil {
			if field.Kind != indexFieldNumeric || len(predicate.In) != 0 || predicate.Equals != nil {
				return "", fmt.Errorf("unsupported Redis numeric predicate for %q", predicate.Field)
			}
			minimum, maximum := "-inf", "+inf"
			if predicate.GTE != nil {
				var ok bool
				minimum, ok = nativeNumber(predicate.GTE)
				if !ok {
					return "", fmt.Errorf("unsupported Redis lower bound for %q", predicate.Field)
				}
			}
			if predicate.LT != nil {
				value, ok := nativeNumber(predicate.LT)
				if !ok {
					return "", fmt.Errorf("unsupported Redis upper bound for %q", predicate.Field)
				}
				maximum = "(" + value
			}
			parts = append(parts, "@"+field.Alias+":["+minimum+" "+maximum+"]")
			continue
		}
		if field.Kind != indexFieldTag {
			return "", fmt.Errorf("redis predicate field %q is not indexed as TAG", predicate.Field)
		}
		values := predicate.In
		if len(values) == 0 {
			values = []any{predicate.Equals}
		}
		tags := make([]string, 0, len(values))
		for _, value := range values {
			text, ok := value.(string)
			if !ok || text == "unknown" || len(text) > 128 || !searchTag.MatchString(text) {
				return "", fmt.Errorf("unsupported Redis predicate value for %q", predicate.Field)
			}
			tags = append(tags, strings.NewReplacer("/", `\/`, "-", `\-`).Replace(text))
		}
		parts = append(parts, "@"+field.Alias+":{"+strings.Join(tags, "|")+"}")
	}
	if len(parts) == 0 {
		return "*", nil
	}
	return strings.Join(parts, " "), nil
}

func findIndexField(fields []indexField, name string) (indexField, bool) {
	for _, field := range fields {
		if field.Name == name {
			return field, true
		}
	}
	return indexField{}, false
}

func findPipelineField(indexed []indexField, computed map[string]indexField, name string) (indexField, bool) {
	if field, ok := findIndexField(indexed, name); ok {
		return field, true
	}
	field, ok := computed[name]
	return field, ok
}

func nativeComputedExpression(
	definition query.ComputedField, indexed []indexField, computed map[string]indexField,
) (string, indexField, bool, error) {
	result := indexField{Name: definition.As, Alias: nativeFieldAlias(definition.As), Required: true}
	if definition.Function == "literal" {
		if len(definition.Args) != 1 || definition.Args[0].Field != nil || definition.Args[0].Context != "" {
			return "", indexField{}, false, errors.New("unsupported literal")
		}
		expression, err := nativeLiteral(definition.Args[0].Value)
		if err != nil {
			return "", indexField{}, false, err
		}
		switch value := definition.Args[0].Value.(type) {
		case string:
			result.Kind = indexFieldTag
			result.Required = value != ""
		case float64, int, int64:
			result.Kind = indexFieldNumeric
		case bool:
			result.Kind = indexFieldTag
			return expression, result, true, nil
		}
		return expression, result, false, nil
	}
	if definition.Function != "number" && definition.Function != "sum" &&
		definition.Function != "difference" && definition.Function != "product" &&
		definition.Function != "greater-than" {
		return "", indexField{}, false, fmt.Errorf("unsupported function %q", definition.Function)
	}
	arguments := make([]string, 0, len(definition.Args))
	for _, argument := range definition.Args {
		if argument.Context != "" {
			return "", indexField{}, false, errors.New("context arguments are not supported")
		}
		if argument.Field != nil {
			field, ok := findPipelineField(indexed, computed, *argument.Field)
			if !ok || field.Kind != indexFieldNumeric {
				return "", indexField{}, false, fmt.Errorf("field %q is not numeric", *argument.Field)
			}
			arguments = append(arguments, "@"+field.Alias)
			continue
		}
		literal, ok := nativeNumber(argument.Value)
		if !ok {
			return "", indexField{}, false, errors.New("numeric literal is required")
		}
		arguments = append(arguments, literal)
	}
	if len(arguments) == 0 {
		return "", indexField{}, false, errors.New("numeric arguments are required")
	}
	result.Kind = indexFieldNumeric
	switch definition.Function {
	case "number":
		return arguments[0], result, false, nil
	case "sum":
		return "(" + strings.Join(arguments, "+") + ")", result, false, nil
	case "difference":
		if len(arguments) != 2 {
			return "", indexField{}, false, errors.New("difference requires two arguments")
		}
		return "(" + arguments[0] + "-" + arguments[1] + ")", result, false, nil
	case "product":
		return "(" + strings.Join(arguments, "*") + ")", result, false, nil
	case "greater-than":
		if len(arguments) != 2 {
			return "", indexField{}, false, errors.New("greater-than requires two arguments")
		}
		result.Kind = indexFieldTag
		return "(" + arguments[0] + ">" + arguments[1] + ")", result, true, nil
	default:
		return "", indexField{}, false, errors.New("unsupported numeric function")
	}
}

func nativeReducer(reducer string, field indexField) (string, []string, bool) {
	switch reducer {
	case "count":
		if !field.Required {
			return "", nil, false
		}
		return "COUNT", nil, true
	case "distinct-count":
		return "COUNT_DISTINCT", []string{"@" + field.Alias}, true
	case "sum":
		return "SUM", []string{"@" + field.Alias}, field.Kind == indexFieldNumeric
	case "mean":
		return "AVG", []string{"@" + field.Alias}, field.Kind == indexFieldNumeric
	case "min":
		return "MIN", []string{"@" + field.Alias}, field.Kind == indexFieldNumeric
	case "max":
		return "MAX", []string{"@" + field.Alias}, field.Kind == indexFieldNumeric
	default:
		return "", nil, false
	}
}

func nativeNumber(value any) (string, bool) {
	switch value := value.(type) {
	case int:
		return strconv.Itoa(value), true
	case int64:
		return strconv.FormatInt(value, 10), true
	case float64:
		return strconv.FormatFloat(value, 'g', -1, 64), true
	default:
		return "", false
	}
}

func decodeAggregateRows(value any, outputFields map[string]outputField) ([]model.Row, error) {
	response, ok := value.([]any)
	if !ok || len(response) == 0 {
		return nil, errors.New("invalid FT.AGGREGATE response")
	}
	rows := make([]model.Row, 0, len(response)-1)
	for _, raw := range response[1:] {
		fields, ok := raw.([]any)
		if !ok || len(fields)%2 != 0 {
			return nil, errors.New("invalid FT.AGGREGATE row")
		}
		row := make(model.Row, len(fields)/2)
		for index := 0; index < len(fields); index += 2 {
			alias := fmt.Sprint(fields[index])
			output, wanted := outputFields[alias]
			if wanted {
				row[output.name] = nativeResultValue(
					fields[index+1], output.fromLoad, output.numeric, output.boolean,
				)
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// nativeResultValue decodes a single FT.AGGREGATE result field. Fields loaded
// through a JSONPath (fromLoad) are unwrapped from the single-element array
// that DIALECT 4 preserves for scalar JSONPath matches.
func nativeResultValue(value any, fromLoad, numeric, boolean bool) any {
	text := fmt.Sprint(value)
	if boolean {
		if text == "1" {
			return true
		}
		if text == "0" {
			return false
		}
	}
	if numeric {
		if number, err := strconv.ParseFloat(text, 64); err == nil {
			return number
		}
	}
	if strings.HasPrefix(text, `"`) || strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") ||
		text == "true" || text == "false" || text == "null" {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) == nil {
			if fromLoad {
				if items, ok := decoded.([]any); ok && len(items) == 1 {
					return items[0]
				}
			}
			return decoded
		}
	}
	return text
}

func nativeLiteral(value any) (string, error) {
	switch value := value.(type) {
	case string:
		return strconv.Quote(value), nil
	case float64:
		return strconv.FormatFloat(value, 'g', -1, 64), nil
	case int:
		return strconv.Itoa(value), nil
	case int64:
		return strconv.FormatInt(value, 10), nil
	case bool:
		if value {
			return "1", nil
		}
		return "0", nil
	default:
		return "", fmt.Errorf("unsupported literal type %T", value)
	}
}

func nativeFieldAlias(field string) string { return strings.ReplaceAll(field, "-", "_") }

func redisJSONPath(field string) string {
	return `$["` + strings.ReplaceAll(field, `"`, `\"`) + `"]`
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}
