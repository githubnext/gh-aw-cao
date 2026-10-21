package sqlitex

import (
	"sort"

	"github.com/githubnext/gh-cao/server/internal/query"
)

type snapshotFields struct {
	all    bool
	fields map[string]bool
}

// Bound projection to row-local stages with complete field lineage. Unknown
// shapes keep full documents; this never drops a join or changes cardinality.
func projectSnapshotPlan(definitions []query.Definition, requested, order []string) ([]query.Definition, map[string]snapshotFields) {
	result := append([]query.Definition(nil), definitions...)
	index := make(map[string]int, len(result))
	for position, definition := range result {
		index[definition.Name] = position
	}
	demands := map[string]snapshotFields{}
	require := func(name string, fields []string, all bool) {
		demand := demands[name]
		demand.all = demand.all || all
		if demand.fields == nil {
			demand.fields = map[string]bool{}
		}
		for _, field := range fields {
			demand.fields[field] = true
		}
		demands[name] = demand
	}
	for _, name := range requested {
		require(name, nil, true)
	}
	for position := len(order) - 1; position >= 0; position-- {
		name := order[position]
		entry, derived := index[name]
		if !derived {
			continue
		}
		definition := result[entry]
		demand := demands[name]
		opaque := definition.TemporalSeries != nil || len(definition.Predict) > 0 ||
			len(definition.Window) > 0 || definition.Facet != nil
		if !demand.all && !opaque && definition.Aggregate == nil &&
			len(definition.OrderBy) == 0 && definition.Limit == nil {
			live := make(map[string]bool, len(demand.fields))
			for field := range demand.fields {
				live[field] = true
			}
			selected := []query.SelectedField{}
			if len(definition.Select) > 0 {
				for _, field := range definition.Select {
					alias := field.As
					if alias == "" {
						alias = field.Field
					}
					if live[alias] {
						selected = append(selected, field)
					}
				}
			} else {
				fields := make([]string, 0, len(live))
				for field := range live {
					fields = append(fields, field)
				}
				sort.Strings(fields)
				for _, field := range fields {
					selected = append(selected, query.SelectedField{Field: field})
				}
			}
			if len(selected) > 0 {
				definition.Select = selected
				live = map[string]bool{}
				for _, field := range selected {
					live[field.Field] = true
				}
				computes := make([]query.ComputedField, 0, len(definition.Compute))
				for i := len(definition.Compute) - 1; i >= 0; i-- {
					compute := definition.Compute[i]
					if !live[compute.As] {
						continue
					}
					computes = append(computes, compute)
					delete(live, compute.As)
					for _, arg := range compute.Args {
						if arg.Field != nil {
							live[*arg.Field] = true
						}
					}
				}
				for left, right := 0, len(computes)-1; left < right; left, right = left+1, right-1 {
					computes[left], computes[right] = computes[right], computes[left]
				}
				definition.Compute = computes
				result[entry] = definition
			}
		}
		normalized := query.Normalize(definition)
		// Temporal output is closed and all its source fields are declared.
		// Keep opaque stages conservative without reading unrelated documents
		// merely because a temporal transform is not row-local.
		full := normalized.ResultShape.Mode == query.PreserveInput || len(definition.Predict) > 0 ||
			len(definition.Window) > 0 || definition.Facet != nil
		require(definition.From, normalized.SourceFields, full)
		for _, source := range definition.Union {
			require(source, normalized.SourceFields, full)
		}
		for source, fields := range normalized.JoinFields {
			require(source, fields, false)
		}
	}
	return result, demands
}
