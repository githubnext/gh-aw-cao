package redisx

import (
	"fmt"
	"sort"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

const (
	indexFieldTag     = "TAG"
	indexFieldText    = "TEXT"
	indexFieldNumeric = "NUMERIC"
)

type indexField struct {
	Name     string `json:"name"`
	Alias    string `json:"alias"`
	Kind     string `json:"kind"`
	Sortable bool   `json:"sortable,omitempty"`
	Required bool   `json:"required,omitempty"`
}

type indexFieldRequirement struct {
	kind     string
	sortable bool
}

func indexSchemaForSource(source model.Source, definitions []query.Definition) ([]indexField, error) {
	requirements := make(map[string]indexFieldRequirement)
	for _, field := range indexedStringFields(source.Rows) {
		requirements[field] = indexFieldRequirement{kind: indexFieldTag}
	}
	for _, definition := range definitions {
		if definition.From != source.Source || len(definition.Union) != 0 || len(definition.Joins) != 0 {
			continue
		}
		if definition.Filter != nil {
			for _, predicate := range definition.Filter.Predicates {
				kind := indexFieldTag
				if predicate.GTE != nil || predicate.LT != nil {
					kind = indexFieldNumeric
				}
				mergeIndexRequirement(requirements, predicate.Field, indexFieldRequirement{kind: kind})
			}
			if definition.Filter.Search != nil {
				for _, field := range definition.Filter.Search.Fields {
					mergeIndexRequirement(requirements, field, indexFieldRequirement{kind: indexFieldText})
				}
			}
		}
		for _, computed := range definition.Compute {
			for _, argument := range computed.Args {
				if argument.Field != nil {
					mergeIndexRequirement(requirements, *argument.Field, indexFieldRequirement{sortable: true})
				}
			}
		}
		if definition.Aggregate != nil {
			for _, field := range definition.Aggregate.By {
				mergeIndexRequirement(requirements, field, indexFieldRequirement{sortable: true})
			}
			for _, value := range definition.Aggregate.Values {
				mergeIndexRequirement(requirements, value.Field, indexFieldRequirement{sortable: true})
			}
		}
		for _, field := range definition.OrderBy {
			mergeIndexRequirement(requirements, field.Field, indexFieldRequirement{sortable: true})
		}
	}

	names := make([]string, 0, len(requirements))
	for name := range requirements {
		names = append(names, name)
	}
	sort.Strings(names)
	aliases := make(map[string]string, len(names))
	fields := make([]indexField, 0, len(names))
	for _, name := range names {
		requirement := requirements[name]
		kind, required, ok := inferIndexFieldKind(source.Rows, name, requirement.kind)
		if !ok {
			continue
		}
		alias := nativeFieldAlias(name)
		if previous, exists := aliases[alias]; exists && previous != name {
			return nil, fmt.Errorf("redis index alias collision between %q and %q", previous, name)
		}
		aliases[alias] = name
		fields = append(fields, indexField{
			Name: name, Alias: alias, Kind: kind, Sortable: requirement.sortable, Required: required,
		})
	}
	return fields, nil
}

func redisIndexSchema(fields []indexField) []string {
	schema := make([]string, 0, len(fields)*6)
	for _, field := range fields {
		schema = append(schema, redisJSONPath(field.Name), "AS", field.Alias, field.Kind)
		if field.Kind == indexFieldTag {
			schema = append(schema, "CASESENSITIVE")
		}
		if field.Sortable {
			schema = append(schema, "SORTABLE")
		}
	}
	return schema
}

func mergeIndexRequirement(requirements map[string]indexFieldRequirement, field string, incoming indexFieldRequirement) {
	if !nativeQueryField.MatchString(field) {
		return
	}
	current := requirements[field]
	if incoming.kind != "" {
		current.kind = incoming.kind
	}
	current.sortable = current.sortable || incoming.sortable
	requirements[field] = current
}

func inferIndexFieldKind(rows []model.Row, field, requested string) (string, bool, bool) {
	kind := ""
	required := len(rows) > 0
	for _, row := range rows {
		value := row[field]
		if value == nil || value == "" {
			required = false
			continue
		}
		var candidate string
		switch value.(type) {
		case string:
			candidate = indexFieldTag
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			candidate = indexFieldNumeric
		default:
			return "", false, false
		}
		if kind != "" && kind != candidate {
			return "", false, false
		}
		kind = candidate
	}
	if kind == "" {
		return "", false, false
	}
	if requested == indexFieldText && kind == indexFieldTag {
		return indexFieldText, required, true
	}
	if requested != "" && requested != kind {
		return "", false, false
	}
	return kind, required, true
}
