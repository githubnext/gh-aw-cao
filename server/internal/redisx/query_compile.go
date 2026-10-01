package redisx

import (
	"fmt"
	"sort"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// QueryCompilation describes an offline candidate for Redis pushdown. These
// candidates do not describe the currently published hash-backed dataset,
// which always evaluates queries through the Go engine.
type QueryCompilation struct {
	Name            string                    `json:"name"`
	From            string                    `json:"from"`
	Level           string                    `json:"level"`
	Native          string                    `json:"native"`
	Reason          string                    `json:"reason,omitempty"`
	ResultShape     query.ResultShape         `json:"resultShape"`
	RequiredFields  query.FieldSet            `json:"requiredFields"`
	SourceFields    query.FieldSet            `json:"sourceFields"`
	TransientFields query.FieldSet            `json:"transientFields"`
	JoinFields      map[string]query.FieldSet `json:"joinFields,omitempty"`
	NativePrefix    []string                  `json:"nativePrefix"`
	FallbackSuffix  []string                  `json:"fallbackSuffix"`
	RedisCommands   []string                  `json:"redisCommands"`
}

// CompileQueries evaluates possible native plans against inferred fields;
// these are hypothetical plans, not live execution or an index availability
// guarantee for the current dataset storage format.
func CompileQueries(definitions []query.Definition, runtimeSources ...string) ([]QueryCompilation, error) {
	if len(definitions) == 0 || len(definitions) > 2048 {
		return nil, fmt.Errorf("expected between 1 and 2048 dashboard queries")
	}
	names := make(map[string]bool, len(definitions))
	runtime := make(map[string]bool, len(runtimeSources))
	for _, source := range runtimeSources {
		runtime[source] = true
	}
	for _, definition := range definitions {
		if names[definition.Name] {
			return nil, fmt.Errorf("duplicate query %q", definition.Name)
		}
		names[definition.Name] = true
	}
	results := make([]QueryCompilation, 0, len(definitions))
	for _, definition := range definitions {
		plan := query.Normalize(definition)
		result := QueryCompilation{
			Name: definition.Name, From: definition.From, Level: "fallback", Native: "none",
			ResultShape: plan.ResultShape, RequiredFields: plan.RequiredFields,
			SourceFields: plan.SourceFields, TransientFields: plan.TransientFields, JoinFields: plan.JoinFields,
			NativePrefix: []string{}, FallbackSuffix: []string{}, RedisCommands: []string{},
		}
		validationError := query.Validate([]query.Definition{definition})
		switch {
		case validationError != nil:
			result.Level = "unsupported"
			result.Reason = validationError.Error()
		case names[definition.From]:
			result.Reason = "query dependency requires Go execution"
		case runtime[definition.From]:
			result.Reason = "server runtime source is not a RedisJSON index"
		case definition.From == "issues":
			result.Reason = "issue overlays require Go execution"
		default:
			fields, err := inferredIndexFields(definition)
			if err == nil {
				_, _, err = nativeAggregateCommand("offline-index", definition, fields)
			}
			if err == nil {
				result.Level, result.Native = "full candidate", "FT.AGGREGATE"
				result.RedisCommands = []string{"FT.AGGREGATE"}
			} else {
				result.Reason = err.Error()
			}
			if fields != nil && definition.Filter != nil && len(definition.Filter.Predicates) > 0 &&
				len(definition.Union) == 0 && len(definition.Joins) == 0 &&
				indexedPredicate(definition.Filter, inferredIndexNames(definition)) != "" &&
				result.Level == "fallback" {
				result.Level, result.Native = "partial candidate", "FT.SEARCH candidate selection"
				result.NativePrefix = append(result.NativePrefix, "indexed-candidates")
				result.RedisCommands = []string{"FT.SEARCH", "HMGET"}
			}
			if label, _, ok := nativeTableCount(&definition); ok && label != "" &&
				result.Level == "fallback" {
				result.Level, result.Native = "partial candidate", "SCARD"
				result.NativePrefix = append(result.NativePrefix, "compute", "aggregate")
				result.RedisCommands = []string{"SCARD"}
			}
		}
		for _, stage := range plan.Stages {
			if stage.Operator == "from" {
				continue
			}
			if result.Level == "full candidate" {
				result.NativePrefix = append(result.NativePrefix, stage.Operator)
			} else if result.Level != "unsupported" {
				if result.Native == "SCARD" && (stage.Operator == "compute" || stage.Operator == "aggregate") {
					continue
				}
				result.FallbackSuffix = append(result.FallbackSuffix, stage.Operator)
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
