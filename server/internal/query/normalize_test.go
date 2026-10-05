package query

import (
	"reflect"
	"testing"
)

func TestNormalizeSeparatesLivenessFromResultShape(t *testing.T) {
	input := "duration"
	definition := Definition{
		From:    "runs",
		Filter:  &Filter{Predicates: []Predicate{{Field: "conclusion", Equals: "failure"}}},
		Compute: []ComputedField{{As: "double", Function: "product", Args: []Argument{{Field: &input}, {Value: 2}}}},
		Aggregate: &Aggregate{By: []string{"workflow"}, Values: []AggregateValue{{
			Field: "double", As: "total", Reducer: "sum",
			Filter: &Filter{Predicates: []Predicate{{Field: "actor", Equals: "bot"}}},
		}}},
		OrderBy: []OrderField{{Field: "total", Direction: "desc"}},
	}
	plan := Normalize(definition)
	want := []ResultField{{Field: "workflow", As: "workflow"}, {Field: "total", As: "total"}}
	if plan.ResultShape.Mode != ClosedShape || !reflect.DeepEqual(plan.ResultShape.Fields, want) {
		t.Fatalf("aggregate output was inferred from liveness: %+v", plan.ResultShape)
	}
	if !reflect.DeepEqual(plan.SourceFields, FieldSet{"actor", "conclusion", "duration", "workflow"}) {
		t.Fatalf("incorrect source fields: %v", plan.SourceFields)
	}
	if !reflect.DeepEqual(plan.TransientFields, FieldSet{"actor", "conclusion", "double", "duration"}) {
		t.Fatalf("incorrect transient fields: %v", plan.TransientFields)
	}
	if !reflect.DeepEqual(plan.Stages[2].LiveAfter, FieldSet{"actor", "double", "workflow"}) {
		t.Fatalf("compute input should die after use: %+v", plan.Stages[2])
	}
	if !reflect.DeepEqual(plan, Normalize(definition)) {
		t.Fatal("normalization is not deterministic")
	}
}

func TestNormalizePreservesUnknownFieldsUntilClosedProjection(t *testing.T) {
	definition := Definition{
		From: "runs", Joins: []Join{{Source: "actors", On: []JoinKey{{Left: "actor", Right: "id"}},
			Fields: []SelectedField{{Field: "name", As: "actor-name"}}}},
		Filter:  &Filter{Predicates: []Predicate{{Field: "status", Equals: "success"}}},
		Select:  []SelectedField{{Field: "run"}},
		OrderBy: []OrderField{{Field: "started-at", Direction: "desc"}},
	}
	plan := Normalize(definition)
	if plan.ResultShape.Mode != ClosedShape ||
		!reflect.DeepEqual(plan.ResultShape.Fields, []ResultField{{Field: "run", As: "run"}}) {
		t.Fatalf("select must close the result: %+v", plan.ResultShape)
	}
	if !reflect.DeepEqual(plan.SourceFields, FieldSet{"actor", "run", "status"}) {
		t.Fatalf("order-by after select cannot demand the removed input column: %v", plan.SourceFields)
	}
	if !reflect.DeepEqual(plan.JoinFields["actors"], FieldSet{"id", "name"}) {
		t.Fatalf("join right-side keys and projections were lost: %v", plan.JoinFields)
	}
	definition.Select = nil
	plan = Normalize(definition)
	if plan.ResultShape.Mode != PreserveInput || !reflect.DeepEqual(plan.ResultShape.Added,
		[]ResultField{{Field: "name", As: "actor-name"}}) {
		t.Fatalf("join must preserve source fields: %+v", plan.ResultShape)
	}
	if !reflect.DeepEqual(plan.SourceFields, FieldSet{"actor", "started-at", "status"}) {
		t.Fatalf("unexpected known source requirements: %v", plan.SourceFields)
	}
}

func TestResultShapeModeLabel(t *testing.T) {
	for _, tt := range []struct {
		mode ResultShapeMode
		want string
	}{
		{PreserveInput, "preserve-input"},
		{ClosedShape, "closed-shape"},
		{ResultShapeMode(99), "unknown"},
	} {
		if got := resultShapeModeLabel(tt.mode); got != tt.want {
			t.Fatalf("resultShapeModeLabel(%d) = %q, want %q", tt.mode, got, tt.want)
		}
	}
}

func TestNormalizeWindowDependenciesAndShape(t *testing.T) {
	frame := 2
	definition := Definition{From: "runs", Window: []WindowField{
		{Operation: "rolling", Field: "amount", As: "recent", Frame: &frame,
			GroupBy: []string{"owner"}, OrderBy: []OrderField{{Field: "day"}}},
		{Operation: "change", Field: "recent", As: "rate", Mode: "rate", TimeField: "day", Unit: "day",
			OrderBy: []OrderField{{Field: "day"}}},
	}}
	plan := Normalize(definition)
	if !reflect.DeepEqual(plan.SourceFields, FieldSet{"amount", "day", "owner"}) ||
		!reflect.DeepEqual(plan.ResultShape.Added, []ResultField{{Field: "recent", As: "recent"}, {Field: "rate", As: "rate"}}) ||
		plan.Stages[1].Operator != "window" || plan.Stages[2].Operator != "window" {
		t.Fatalf("window liveness: %+v", plan)
	}
	definition.Aggregate = &Aggregate{By: []string{"owner", "day"}, Values: []AggregateValue{{Field: "amount", As: "amount", Reducer: "sum"}}}
	plan = Normalize(definition)
	if plan.ResultShape.Mode != ClosedShape || len(plan.ResultShape.Fields) != 5 {
		t.Fatalf("window output after aggregate: %+v", plan.ResultShape)
	}
}

func TestNormalizeTemporalShape(t *testing.T) {
	for _, tt := range []struct {
		shape string
		tail  []string
	}{
		{"tidy", []string{"time", "series", "value"}},
		{"groups", []string{"points"}},
	} {
		t.Run(tt.shape, func(t *testing.T) {
			plan := Normalize(Definition{From: "runs", TemporalSeries: &TemporalSeries{
				Time: "started-at", Series: "workflow", Shape: tt.shape, Carry: []string{"repository"},
				Measures: []TemporalMeasure{{Field: "duration", Key: "measure-name"}},
			}})
			fields := append([]string{"repository", "metric", "metric-key", "metric-name", "metric-kind", "metric-group"}, tt.tail...)
			for i, field := range fields {
				if plan.ResultShape.Fields[i].As != field {
					t.Fatalf("field %d: got %+v, want %q", i, plan.ResultShape.Fields[i], field)
				}
			}
			if plan.ResultShape.Mode != ClosedShape || len(plan.ResultShape.Fields) != len(fields) {
				t.Fatalf("wrong temporal shape: %+v", plan.ResultShape)
			}
		})
	}
}
