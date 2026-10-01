package redisx

import (
	"fmt"
	"sort"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// QueryCompilation describes what the Redis compiler can establish without a
// running generation. A candidate still requires a JSON source and compatible
// indexed field types in the active generation.
type QueryCompilation struct {
	Name   string `json:"name"`
	From   string `json:"from"`
	Level  string `json:"level"`
	Native string `json:"native"`
	Reason string `json:"reason,omitempty"`
}

// CompileQueries checks each definition against the same FT.AGGREGATE compiler
// used at runtime. Inferred fields are only an optimistic schema: the report
// must not claim that a query actually executes natively on a live generation.
func CompileQueries(definitions []query.Definition) ([]QueryCompilation, error) {
	if len(definitions) == 0 || len(definitions) > 2048 {
		return nil, fmt.Errorf("expected between 1 and 2048 dashboard queries")
	}
	names := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		if names[definition.Name] {
			return nil, fmt.Errorf("duplicate query %q", definition.Name)
		}
		names[definition.Name] = true
	}
	results := make([]QueryCompilation, 0, len(definitions))
	for _, definition := range definitions {
		result := QueryCompilation{Name: definition.Name, From: definition.From, Level: "fallback", Native: "none"}
		validationError := query.Validate([]query.Definition{definition})
		switch {
		case validationError != nil:
			result.Level = "unsupported"
			result.Reason = validationError.Error()
		case names[definition.From]:
			result.Reason = "query dependency requires Go execution"
		case definition.From == "issues":
			result.Reason = "issue overlays require Go execution"
		default:
			fields, err := inferredIndexFields(definition)
			if err == nil {
				_, _, err = nativeAggregateCommand("offline-index", definition, fields)
			}
			if err == nil {
				result.Level, result.Native = "full candidate", "FT.AGGREGATE"
			} else {
				result.Reason = err.Error()
			}
			if fields != nil && definition.Filter != nil && len(definition.Filter.Predicates) > 0 &&
				len(definition.Union) == 0 && len(definition.Joins) == 0 &&
				indexedPredicate(definition.Filter, inferredIndexNames(definition)) != "" &&
				result.Level == "fallback" {
				result.Level, result.Native = "partial candidate", "FT.SEARCH candidate selection"
			}
			if label, _, ok := nativeTableCount(&definition); ok && label != "" &&
				result.Level == "fallback" {
				result.Level, result.Native = "partial candidate", "SCARD"
			}
		}
		results = append(results, result)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Name < results[j].Name })
	return results, nil
}

func inferredIndexNames(definition query.Definition) []string {
	names := make([]string, 0)
	if definition.Filter != nil {
		for _, predicate := range definition.Filter.Predicates {
			names = append(names, predicate.Field)
		}
	}
	return names
}

func inferredIndexFields(definition query.Definition) ([]indexField, error) {
	fields := make(map[string]indexField)
	add := func(name, kind string) {
		if !nativeQueryField.MatchString(name) {
			return
		}
		field := fields[name]
		if field.Name == "" {
			field = indexField{Name: name, Alias: nativeFieldAlias(name), Kind: kind, Required: true}
		}
		if kind == indexFieldNumeric {
			field.Kind = kind
		}
		fields[name] = field
	}
	if definition.Filter != nil {
		for _, predicate := range definition.Filter.Predicates {
			kind := indexFieldTag
			if predicate.GTE != nil || predicate.LT != nil {
				kind = indexFieldNumeric
			}
			add(predicate.Field, kind)
		}
	}
	for _, computed := range definition.Compute {
		if computed.Function == "literal" {
			continue
		}
		for _, argument := range computed.Args {
			if argument.Field != nil {
				add(*argument.Field, indexFieldNumeric)
			}
		}
	}
	if definition.Aggregate != nil {
		for _, name := range definition.Aggregate.By {
			add(name, indexFieldTag)
		}
		for _, value := range definition.Aggregate.Values {
			kind := indexFieldTag
			if value.Reducer == "sum" || value.Reducer == "mean" ||
				value.Reducer == "min" || value.Reducer == "max" {
				kind = indexFieldNumeric
			}
			add(value.Field, kind)
		}
	}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]indexField, 0, len(names))
	aliases := make(map[string]string)
	for _, name := range names {
		field := fields[name]
		if previous, ok := aliases[field.Alias]; ok && previous != name {
			return nil, fmt.Errorf("redis index alias collision between %q and %q", previous, name)
		}
		aliases[field.Alias] = name
		result = append(result, field)
	}
	return result, nil
}
