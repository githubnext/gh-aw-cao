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

func (a *Argument) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if field, ok := raw["field"]; ok {
		var value string
		if err := json.Unmarshal(field, &value); err != nil {
			return err
		}
		a.Field = &value
		return nil
	}
	if value, ok := raw["value"]; ok {
		return json.Unmarshal(value, &a.Value)
	}
	if contextValue, ok := raw["context"]; ok {
		return json.Unmarshal(contextValue, &a.Context)
	}
	return fmt.Errorf("compute argument must contain field, value, or context")
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
