package query

import (
	"encoding/json"
	"sort"
)

// resultShapeModeLabel names a NormalizedQuery's result-shape mode, stable
// across the ResultShapeMode constant's underlying values so it is useful to
// log without exposing the query's actual field names.
func resultShapeModeLabel(mode ResultShapeMode) string {
	switch mode {
	case ClosedShape:
		return "closed-shape"
	case PreserveInput:
		return "preserve-input"
	default:
		return "unknown"
	}
}

type FieldSet []string

type ResultShapeMode int

const (
	PreserveInput ResultShapeMode = iota
	ClosedShape
)

type ResultField struct {
	Field string `json:"field"`
	As    string `json:"as"`
}

type ResultShape struct {
	Mode   ResultShapeMode `json:"mode"`
	Fields []ResultField   `json:"fields,omitempty"`
	Added  []ResultField   `json:"added,omitempty"`
}

type StageFields struct {
	Operator   string   `json:"operator"`
	Required   FieldSet `json:"required,omitempty"`
	LiveBefore FieldSet `json:"live-before,omitempty"`
	LiveAfter  FieldSet `json:"live-after,omitempty"`
}

// NormalizedQuery describes output shape independently of the fields needed
// temporarily to evaluate the query. A preserving shape, including a facet's
// input shape, requires full source documents even if SourceFields names only
// a few known columns.
type NormalizedQuery struct {
	Source          string              `json:"source"`
	Filter          *Filter             `json:"filter,omitempty"`
	Computes        []ComputedField     `json:"computes,omitempty"`
	Aggregate       *Aggregate          `json:"aggregate,omitempty"`
	Window          []WindowField       `json:"window,omitempty"`
	TemporalSeries  *TemporalSeries     `json:"temporal-series,omitempty"`
	Order           []OrderField        `json:"order,omitempty"`
	Limit           *int                `json:"limit,omitempty"`
	Facet           *Facet              `json:"facet,omitempty"`
	FacetInputShape *ResultShape        `json:"facet-input-shape,omitempty"`
	RequiredFields  FieldSet            `json:"required-fields,omitempty"`
	SourceFields    FieldSet            `json:"source-fields,omitempty"`
	JoinFields      map[string]FieldSet `json:"join-fields,omitempty"`
	TransientFields FieldSet            `json:"transient-fields,omitempty"`
	OutputFields    FieldSet            `json:"output-fields,omitempty"`
	ResultShape     ResultShape         `json:"result-shape"`
	Stages          []StageFields       `json:"stages"`
}

func sortedFields(fields map[string]bool) FieldSet {
	result := make(FieldSet, 0, len(fields))
	for field := range fields {
		if field != "" {
			result = append(result, field)
		}
	}
	sort.Strings(result)
	return result
}

func filterFields(filter *Filter) map[string]bool {
	fields := map[string]bool{}
	if filter != nil {
		for _, predicate := range filter.Predicates {
			fields[predicate.Field] = true
		}
		if filter.Search != nil {
			for _, field := range filter.Search.Fields {
				fields[field] = true
			}
		}
	}
	return fields
}

func Normalize(definition Definition) NormalizedQuery {
	plan := NormalizedQuery{
		Source: definition.From, Filter: definition.Filter, Computes: definition.Compute,
		Aggregate: definition.Aggregate, TemporalSeries: definition.TemporalSeries, Window: definition.Window,
		Order: definition.OrderBy, Limit: definition.Limit, Facet: definition.Facet,
		ResultShape: ResultShape{Mode: PreserveInput}, Stages: []StageFields{},
	}
	type stage struct {
		name     string
		requires map[string]bool
		produces map[string]bool
		closes   bool
	}
	stages := []stage{{name: "from", requires: map[string]bool{}, produces: map[string]bool{}}}
	if len(definition.Union) > 0 {
		stages = append(stages, stage{name: "union", requires: map[string]bool{}, produces: map[string]bool{}})
	}
	for _, join := range definition.Joins {
		required, produced := map[string]bool{}, map[string]bool{}
		right := map[string]bool{}
		for _, key := range join.On {
			required[key.Left] = true
			right[key.Right] = true
		}
		for _, field := range join.Fields {
			produced[alias(field)] = true
			right[field.Field] = true
		}
		if plan.JoinFields == nil {
			plan.JoinFields = map[string]FieldSet{}
		}
		for _, field := range plan.JoinFields[join.Source] {
			right[field] = true
		}
		plan.JoinFields[join.Source] = sortedFields(right)
		stages = append(stages, stage{name: "join", requires: required, produces: produced})
		for _, field := range join.Fields {
			plan.ResultShape.Added = append(plan.ResultShape.Added, ResultField{Field: field.Field, As: alias(field)})
		}
	}
	if definition.Filter != nil {
		stages = append(stages, stage{name: "filter", requires: filterFields(definition.Filter), produces: map[string]bool{}})
	}
	for _, compute := range definition.Compute {
		required := map[string]bool{}
		for _, arg := range compute.Args {
			if arg.Field != nil {
				required[*arg.Field] = true
			}
		}
		stages = append(stages, stage{name: "compute", requires: required, produces: map[string]bool{compute.As: true}})
		plan.ResultShape.Added = append(plan.ResultShape.Added, ResultField{Field: compute.As, As: compute.As})
	}
	if definition.Aggregate != nil {
		required, produced := map[string]bool{}, map[string]bool{}
		plan.ResultShape = ResultShape{Mode: ClosedShape}
		for _, field := range definition.Aggregate.By {
			required[field], produced[field] = true, true
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, ResultField{Field: field, As: field})
		}
		for _, value := range definition.Aggregate.Values {
			required[value.Field], produced[value.As] = true, true
			for field := range filterFields(value.Filter) {
				required[field] = true
			}
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, ResultField{Field: value.As, As: value.As})
		}
		stages = append(stages, stage{name: "aggregate", requires: required, produces: produced, closes: true})
	}
	if series := definition.TemporalSeries; series != nil {
		required := map[string]bool{series.Time: true, series.Series: true}
		if series.Link != "" {
			required[series.Link] = true
		}
		for _, field := range series.Carry {
			required[field] = true
		}
		for _, measure := range series.Measures {
			required[measure.Field] = true
			if measure.Key != "" {
				required[measure.Key] = true
			}
		}
		for _, mapping := range series.Maps {
			required[mapping.Field] = true
			if mapping.Group != "" {
				required[mapping.Group] = true
			}
		}
		names := append([]string{}, series.Carry...)
		names = append(names, "metric", "metric-key", "metric-name", "metric-kind", "metric-group")
		switch series.Shape {
		case "groups":
			names = append(names, "points")
		case "panels":
			names = append(names, "series")
		default:
			names = append(names, "time", "series", "value")
		}
		produced := map[string]bool{}
		plan.ResultShape = ResultShape{Mode: ClosedShape}
		for _, name := range names {
			produced[name] = true
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, ResultField{Field: name, As: name})
		}
		stages = append(stages, stage{name: "temporal-series", requires: required, produces: produced, closes: true})
	}
	for _, prediction := range definition.Predict {
		var fields struct {
			As string `json:"as"`
		}
		if json.Unmarshal(prediction, &fields) == nil && fields.As != "" {
			plan.ResultShape.Added = append(plan.ResultShape.Added, ResultField{Field: fields.As, As: fields.As})
		}
		stages = append(stages, stage{name: "predict", requires: map[string]bool{}, produces: map[string]bool{fields.As: true}})
	}
	for _, entry := range definition.Window {
		required := map[string]bool{entry.Field: true}
		for _, order := range entry.OrderBy {
			required[order.Field] = true
		}
		for _, field := range entry.GroupBy {
			required[field] = true
		}
		if entry.TimeField != "" {
			required[entry.TimeField] = true
		}
		result := ResultField{Field: entry.As, As: entry.As}
		if plan.ResultShape.Mode == ClosedShape {
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, result)
		} else {
			plan.ResultShape.Added = append(plan.ResultShape.Added, result)
		}
		stages = append(stages, stage{name: "window", requires: required, produces: map[string]bool{entry.As: true}})
	}
	if len(definition.Select) > 0 {
		required, produced := map[string]bool{}, map[string]bool{}
		plan.ResultShape = ResultShape{Mode: ClosedShape}
		for _, field := range definition.Select {
			required[field.Field], produced[alias(field)] = true, true
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, ResultField{Field: field.Field, As: alias(field)})
		}
		stages = append(stages, stage{name: "select", requires: required, produces: produced, closes: true})
	}
	if len(definition.OrderBy) > 0 {
		required := map[string]bool{}
		for _, field := range definition.OrderBy {
			required[field.Field] = true
		}
		stages = append(stages, stage{name: "order-by", requires: required, produces: map[string]bool{}})
	}
	if definition.Limit != nil {
		stages = append(stages, stage{name: "limit", requires: map[string]bool{}, produces: map[string]bool{}})
	}
	if facet := definition.Facet; facet != nil {
		inputShape := plan.ResultShape
		plan.FacetInputShape = &inputShape
		required := map[string]bool{facet.Field: true, facet.Row: true, facet.Column: true}
		for _, field := range append(append([]ResultField{}, inputShape.Fields...), inputShape.Added...) {
			required[field.As] = true
		}
		plan.ResultShape = ResultShape{Mode: ClosedShape}
		produced := map[string]bool{}
		for _, field := range []string{"facet-field", "facet-row", "facet-column", "facet-row-index", "facet-column-index", facet.As} {
			produced[field] = true
			plan.ResultShape.Fields = append(plan.ResultShape.Fields, ResultField{Field: field, As: field})
		}
		stages = append(stages, stage{name: "facet", requires: required, produces: produced, closes: true})
	}

	live := map[string]bool{}
	if plan.ResultShape.Mode == ClosedShape {
		for _, field := range plan.ResultShape.Fields {
			live[field.As] = true
			plan.OutputFields = append(plan.OutputFields, field.As)
		}
	} else {
		for _, field := range plan.ResultShape.Added {
			live[field.As] = true
			plan.OutputFields = append(plan.OutputFields, field.As)
		}
	}
	plan.Stages = make([]StageFields, len(stages))
	all := map[string]bool{}
	for i := len(stages) - 1; i >= 0; i-- {
		current := stages[i]
		after := sortedFields(live)
		if current.closes {
			live = map[string]bool{}
		} else {
			for field := range current.produces {
				delete(live, field)
			}
		}
		for field := range current.requires {
			live[field] = true
			all[field] = true
		}
		plan.Stages[i] = StageFields{Operator: current.name, Required: sortedFields(current.requires), LiveBefore: sortedFields(live), LiveAfter: after}
	}
	plan.SourceFields = sortedFields(live)
	plan.RequiredFields = sortedFields(all)
	transient := map[string]bool{}
	for field := range all {
		transient[field] = true
	}
	for _, field := range plan.OutputFields {
		delete(transient, field)
	}
	plan.TransientFields = sortedFields(transient)
	queryLog.Printf("normalized query source=%s shape=%s stages=%d source_fields=%d output_fields=%d",
		plan.Source, resultShapeModeLabel(plan.ResultShape.Mode), len(plan.Stages),
		len(plan.SourceFields), len(plan.OutputFields))
	return plan
}
