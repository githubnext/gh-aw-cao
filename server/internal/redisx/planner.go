package redisx

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type Plan struct {
	Command        []string
	PushedDown     []string
	Fallback       []string
	Aggregate      bool
	RequiresSearch bool
}

var unsafeSearch = regexp.MustCompile(`([{}()[\]|\\~*+\-:<>"'@])`)

func PlanQuery(index, source string, definition *query.Definition, aliases, types map[string]string) Plan {
	plan := Plan{
		Command: []string{"FT.SEARCH", index, "*"},
	}
	if definition == nil || definition.From != source || len(definition.Union) > 0 || len(definition.Joins) > 0 || len(definition.Compute) > 0 || definition.TemporalSeries != nil || len(definition.Select) > 0 {
		plan.Fallback = []string{"query"}
		return plan
	}
	expression := []string{}
	if definition.Filter != nil {
		compatible := true
		predicateExpressions := []string{}
		for _, predicate := range definition.Filter.Predicates {
			alias := aliases[predicate.Field]
			if alias == "" || predicate.Optional || predicate.Includes != "" {
				compatible = false
				break
			}
			if predicate.GTE != nil || predicate.LT != nil {
				if types[predicate.Field] != "NUMERIC" {
					compatible = false
					break
				}
				minimum, maximum := "-inf", "+inf"
				if predicate.GTE != nil {
					minimum = redisRangeValue(predicate.GTE)
				}
				if predicate.LT != nil {
					maximum = "(" + redisRangeValue(predicate.LT)
				}
				predicateExpressions = append(predicateExpressions, fmt.Sprintf("@%s:[%s %s]", alias, minimum, maximum))
				continue
			}
			values := predicate.In
			if len(values) == 0 {
				values = []any{predicate.Equals}
			}
			if types[predicate.Field] == "NUMERIC" {
				if len(values) != 1 {
					compatible = false
					break
				}
				value := redisRangeValue(values[0])
				predicateExpressions = append(predicateExpressions, fmt.Sprintf("@%s:[%s %s]", alias, value, value))
				continue
			}
			if types[predicate.Field] != "TAG" {
				compatible = false
				break
			}
			escaped := make([]string, len(values))
			for i, value := range values {
				escaped[i] = escapeTag(fmt.Sprint(value))
			}
			predicateExpressions = append(predicateExpressions, fmt.Sprintf("@%s:{%s}", alias, strings.Join(escaped, "|")))
		}
		if compatible {
			expression = append(expression, predicateExpressions...)
			if len(predicateExpressions) > 0 {
				plan.PushedDown = append(plan.PushedDown, "filter")
			}
		} else {
			plan.Fallback = append(plan.Fallback, "filter")
		}
		if definition.Filter.Search != nil && strings.TrimSpace(definition.Filter.Search.Query) != "" {
			terms := make([]string, 0, len(definition.Filter.Search.Fields))
			for _, field := range definition.Filter.Search.Fields {
				if alias := aliases[field]; alias != "" && types[field] == "TEXT" {
					terms = append(terms, "@"+alias+":"+escapeText(definition.Filter.Search.Query))
				}
			}
			if len(terms) > 0 {
				expression = append(expression, "("+strings.Join(terms, "|")+")")
				plan.PushedDown = append(plan.PushedDown, "search")
			} else {
				plan.Fallback = append(plan.Fallback, "search")
			}
		}
		if containsOperation(plan.Fallback, "filter") || containsOperation(plan.Fallback, "search") {
			for i, operation := range plan.PushedDown {
				if operation == "filter" {
					plan.PushedDown[i] = "filter-partial"
				}
				if operation == "search" {
					plan.PushedDown[i] = "search-partial"
				}
			}
		}
	}
	if len(expression) > 0 {
		plan.Command[2] = strings.Join(expression, " ")
		plan.RequiresSearch = true
	}
	if definition.Aggregate != nil && len(definition.OrderBy) == 0 && definition.Limit == nil {
		compatible := true
		for _, value := range definition.Aggregate.Values {
			switch value.Reducer {
			case "count", "distinct-count", "sum", "mean", "min", "max":
				if value.Filter != nil || aliases[value.Field] == "" {
					compatible = false
				}
				if (value.Reducer == "sum" || value.Reducer == "mean" || value.Reducer == "min" || value.Reducer == "max") &&
					types[value.Field] != "NUMERIC" {
					compatible = false
				}
			default:
				compatible = false
			}
		}
		for _, field := range definition.Aggregate.By {
			if aliases[field] == "" {
				compatible = false
			}
		}
		if compatible {
			plan.Command = []string{"FT.AGGREGATE", index, plan.Command[2]}
			if len(definition.Aggregate.By) > 0 {
				plan.Command = append(plan.Command, "GROUPBY", strconv.Itoa(len(definition.Aggregate.By)))
				for _, field := range definition.Aggregate.By {
					plan.Command = append(plan.Command, "@"+aliases[field])
				}
			} else {
				plan.Command = append(plan.Command, "GROUPBY", "0")
			}
			for _, value := range definition.Aggregate.Values {
				reducer := map[string]string{"count": "COUNT", "distinct-count": "COUNT_DISTINCT", "sum": "SUM", "mean": "AVG", "min": "MIN", "max": "MAX"}[value.Reducer]
				arguments := []string{"REDUCE", reducer}
				if reducer == "COUNT" {
					arguments = append(arguments, "0")
				} else {
					arguments = append(arguments, "1", "@"+aliases[value.Field])
				}
				plan.Command = append(plan.Command, append(arguments, "AS", value.As)...)
			}
			plan.PushedDown = append(plan.PushedDown, "aggregate")
			plan.Aggregate = true
			return plan
		}
		plan.Fallback = append(plan.Fallback, "aggregate")
	}
	if len(definition.OrderBy) == 1 {
		if alias := aliases[definition.OrderBy[0].Field]; alias != "" {
			direction := strings.ToUpper(definition.OrderBy[0].Direction)
			if direction == "" {
				direction = "ASC"
			}
			plan.Command = append(plan.Command, "SORTBY", alias, direction)
			plan.PushedDown = append(plan.PushedDown, "sort")
		} else {
			plan.Fallback = append(plan.Fallback, "sort")
		}
	} else if len(definition.OrderBy) > 1 {
		plan.Fallback = append(plan.Fallback, "sort")
	}
	limit := query.MaxInputRows
	if definition.Limit != nil {
		limit = *definition.Limit
		plan.PushedDown = append(plan.PushedDown, "limit")
	}
	plan.Command = append(plan.Command, "LIMIT", "0", strconv.Itoa(limit), "RETURN", "1", "raw")
	return plan
}

func escapeTag(value string) string {
	return unsafeSearch.ReplaceAllString(value, `\$1`)
}

func escapeText(value string) string {
	words := strings.Fields(value)
	for i, word := range words {
		words[i] = unsafeSearch.ReplaceAllString(word, `\$1`)
	}
	return strings.Join(words, " ")
}

func redisRangeValue(value any) string {
	text := fmt.Sprint(value)
	if instant, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return strconv.FormatInt(instant.UnixMilli(), 10)
	}
	return text
}

func containsOperation(operations []string, target string) bool {
	for _, operation := range operations {
		if operation == target {
			return true
		}
	}
	return false
}
