package query

import (
	"encoding/json"
	"fmt"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

const (
	MaxInputRows             = 200_000
	MaxJoinRows              = 200_000
	MaxOutputRows            = 100_000
	MaxJoins                 = 4
	MaxDependencyDepth       = 16
	MaxPlanQueries           = 256
	MaxDependencyJoins       = 16
	MaxWorkingRows           = 500_000
	MaxRetainedRows          = 500_000
	MaxWorkingBytes          = 256 << 20
	MaxRetainedBytes         = 256 << 20
	MaxAggregateValues       = 64
	MaxPredicateAlternatives = 32
	MaxOperations            = 5_000_000
)

type Definition struct {
	Name           string              `json:"name"`
	From           string              `json:"from"`
	Union          []string            `json:"union,omitempty"`
	Joins          []Join              `json:"joins,omitempty"`
	Filter         *Filter             `json:"filter,omitempty"`
	Compute        []ComputedField     `json:"compute,omitempty"`
	Aggregate      *Aggregate          `json:"aggregate,omitempty"`
	TemporalSeries *TemporalSeries     `json:"temporal-series,omitempty"`
	Predict        []json.RawMessage   `json:"predict,omitempty"`
	Select         []SelectedField     `json:"select,omitempty"`
	OrderBy        []OrderField        `json:"order-by,omitempty"`
	Limit          *int                `json:"limit,omitempty"`
	Stores         []string            `json:"stores,omitempty"`
	StoresBySource map[string][]string `json:"stores-by-source,omitempty"`
}

type Join struct {
	Source string          `json:"source"`
	Type   string          `json:"type,omitempty"`
	On     []JoinKey       `json:"on"`
	Fields []SelectedField `json:"fields"`
}

type JoinKey struct {
	Left  string `json:"left"`
	Right string `json:"right"`
}

type Filter struct {
	Predicates []Predicate `json:"predicates,omitempty"`
	Search     *Search     `json:"search,omitempty"`
}

type Search struct {
	Fields []string `json:"fields"`
	Query  string   `json:"query"`
}

type Predicate struct {
	Field    string `json:"field"`
	Equals   any    `json:"equals,omitempty"`
	In       []any  `json:"in,omitempty"`
	Includes string `json:"includes,omitempty"`
	GTE      any    `json:"gte,omitempty"`
	LT       any    `json:"lt,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

type Argument struct {
	Field   *string `json:"field,omitempty"`
	Value   any     `json:"value,omitempty"`
	Context string  `json:"context,omitempty"`
}

// argumentKind identifies which of the mutually exclusive shapes a compute
// argument's raw JSON object took. It is useful for diagnosing a malformed
// dashboard query document without logging its field names or values.
type argumentKind string

const (
	argumentKindField   argumentKind = "field"
	argumentKindValue   argumentKind = "value"
	argumentKindContext argumentKind = "context"
	argumentKindInvalid argumentKind = "invalid"
)

// classifyArgumentKind inspects a decoded compute-argument object and reports
// which shape it took, checking "field", "value", then "context" in priority
// order. It is a pure function extracted from UnmarshalJSON so the priority
// and rejection logic is testable directly against a raw key set, without
// constructing JSON bytes for every case.
func classifyArgumentKind(raw map[string]json.RawMessage) argumentKind {
	switch {
	case has(raw, "field"):
		return argumentKindField
	case has(raw, "value"):
		return argumentKindValue
	case has(raw, "context"):
		return argumentKindContext
	default:
		return argumentKindInvalid
	}
}

func has(raw map[string]json.RawMessage, key string) bool {
	_, ok := raw[key]
	return ok
}

func (a *Argument) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	switch classifyArgumentKind(raw) {
	case argumentKindField:
		var value string
		if err := json.Unmarshal(raw["field"], &value); err != nil {
			return err
		}
		a.Field = &value
		return nil
	case argumentKindValue:
		return json.Unmarshal(raw["value"], &a.Value)
	case argumentKindContext:
		return json.Unmarshal(raw["context"], &a.Context)
	default:
		queryLog.Printf("compute argument decode rejected reason=missing-field-value-context")
		return fmt.Errorf("compute argument must contain field, value, or context")
	}
}

type ComputedField struct {
	As       string     `json:"as"`
	Function string     `json:"function"`
	Args     []Argument `json:"args"`
}

type Aggregate struct {
	By     []string         `json:"by,omitempty"`
	Values []AggregateValue `json:"values"`
}

type AggregateValue struct {
	Field   string  `json:"field"`
	As      string  `json:"as"`
	Reducer string  `json:"reducer"`
	Filter  *Filter `json:"filter,omitempty"`
}

type SelectedField struct {
	Field string `json:"field"`
	As    string `json:"as,omitempty"`
}

type OrderField struct {
	Field     string `json:"field"`
	Direction string `json:"direction,omitempty"`
}

type TemporalSeries struct {
	Time     string            `json:"time"`
	Series   string            `json:"series"`
	Shape    string            `json:"shape,omitempty"`
	Carry    []string          `json:"carry,omitempty"`
	Measures []TemporalMeasure `json:"measures,omitempty"`
	Maps     []TemporalMap     `json:"maps,omitempty"`
}

type TemporalMeasure struct {
	Field string `json:"field"`
	Key   string `json:"key,omitempty"`
	Kind  string `json:"kind"`
}

type TemporalMap struct {
	Field       string `json:"field"`
	Definitions string `json:"definitions,omitempty"`
	Group       string `json:"group,omitempty"`
	Kind        string `json:"kind"`
}

type Loader interface {
	LoadSource(name string, definition *Definition) (model.Source, model.Metrics, error)
}

type Options struct {
	MaxOperations int
}
