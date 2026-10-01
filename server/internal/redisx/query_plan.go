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
	fields, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "source:"+definition.From+":indexed-fields")
	metrics.RedisCommands++
	if err != nil {
		return nil, metrics, err
	}
	var indexed []string
	if fields != nil {
		if err := json.Unmarshal([]byte(fmt.Sprint(fields)), &indexed); err != nil {
			return nil, metrics, err
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
	metrics.SelectCount = len(definition.Select)
	metrics.OrderByCount = len(definition.OrderBy)
	metrics.LimitCount = boolCount(definition.Limit != nil)
	metrics.OutputRows = len(rows)
	metrics.RedisRows = len(rows)
	return map[string]model.Source{
		definition.Name: {Source: definition.Name, Rows: rows, Metadata: metadata},
	}, metrics, nil
}

func nativeAggregateCommand(index string, definition query.Definition, indexed []string) ([]string, map[string]string, error) {
	if len(definition.Union) != 0 || len(definition.Joins) != 0 || definition.Aggregate != nil ||
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
		if !nativeQueryField.MatchString(field.As) || field.Function != "literal" || len(field.Args) != 1 || field.Args[0].Field != nil || field.Args[0].Context != "" {
			return nil, nil, fmt.Errorf("unsupported Redis computed field %q", field.As)
		}
		computed[field.As] = field
	}
	selected := make(map[string]bool, len(definition.Select))
	loads := make([]string, 0, len(definition.Select)*3)
	outputFields := make(map[string]string, len(definition.Select))
	for _, field := range definition.Select {
		if !nativeQueryField.MatchString(field.Field) {
			return nil, nil, fmt.Errorf("unsupported Redis selected field %q", field.Field)
		}
		alias := nativeFieldAlias(field.Field)
		output := field.As
		if output == "" {
			output = field.Field
		}
		if previous, exists := outputFields[alias]; exists && previous != output {
			return nil, nil, fmt.Errorf("redis field alias collision for %q", field.Field)
		}
		outputFields[alias] = output
		selected[field.Field] = true
		if _, ok := computed[field.Field]; !ok {
			loads = append(loads, redisJSONPath(field.Field), "AS", alias)
		}
	}
	for _, field := range definition.OrderBy {
		if !selected[field.Field] {
			return nil, nil, fmt.Errorf("redis ordering field %q must be projected", field.Field)
		}
	}
	command := []string{"FT.AGGREGATE", index, search}
	if len(loads) != 0 {
		command = append(command, "LOAD", strconv.Itoa(len(loads)))
		command = append(command, loads...)
	}
	for _, field := range definition.Compute {
		expression, err := nativeLiteral(field.Args[0].Value)
		if err != nil {
			return nil, nil, fmt.Errorf("computed field %q: %w", field.As, err)
		}
		command = append(command, "APPLY", expression, "AS", nativeFieldAlias(field.As))
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

func nativeSearchExpression(filter *query.Filter, indexed []string) (string, error) {
	if filter == nil {
		return "*", nil
	}
	if filter.Search != nil {
		return "", errors.New("redis text search requires TEXT indexes")
	}
	parts := make([]string, 0, len(filter.Predicates))
	for _, predicate := range filter.Predicates {
		if predicate.Optional || predicate.Includes != "" || predicate.GTE != nil || predicate.LT != nil || !containsField(indexed, predicate.Field) {
			return "", fmt.Errorf("unsupported Redis predicate for %q", predicate.Field)
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
		parts = append(parts, "@"+nativeFieldAlias(predicate.Field)+":{"+strings.Join(tags, "|")+"}")
	}
	if len(parts) == 0 {
		return "*", nil
	}
	return strings.Join(parts, " "), nil
}

func decodeAggregateRows(value any, outputFields map[string]string) ([]model.Row, error) {
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
				row[output] = nativeResultValue(fields[index+1])
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func nativeResultValue(value any) any {
	text := fmt.Sprint(value)
	if strings.HasPrefix(text, `"`) || strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") ||
		text == "true" || text == "false" || text == "null" {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) == nil {
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
