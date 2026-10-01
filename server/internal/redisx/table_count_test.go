package redisx

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type countCommandClient struct {
	commands []string
	count    int
}

func (client *countCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.commands = append(client.commands, command[0])
	switch command[0] {
	case "HGET":
		return `{"availability":"available"}`, nil
	case "SCARD":
		return client.count, nil
	case "SMEMBERS":
		return []any{}, nil
	default:
		return nil, fmt.Errorf("unexpected Redis command %q", command[0])
	}
}

func (*countCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

type countSourceLoader struct {
	store *Store
}

func (loader countSourceLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return loader.store.LoadSource(context.Background(), "generation", name, definition)
}

func TestNativeTableCountUsesRedisCardinality(t *testing.T) {
	definition := query.Definition{
		Name: "indexing-tools-table-count", From: "tools",
		Compute: []query.ComputedField{{
			As: "table", Function: "literal", Args: []query.Argument{{Value: "tool events"}},
		}},
		Aggregate: &query.Aggregate{
			By:     []string{"table"},
			Values: []query.AggregateValue{{Field: "event", As: "records", Reducer: "count"}},
		},
	}
	for _, count := range []int{0, 175_000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			client := &countCommandClient{count: count}
			store := NewStore(client, "test-count")
			result, metrics, err := query.New(countSourceLoader{store}).Execute(
				[]query.Definition{definition}, []string{definition.Name},
			)
			if err != nil {
				t.Fatal(err)
			}
			want := []model.Row{}
			if count != 0 {
				want = append(want, model.Row{"table": "tool events", "records": count})
			}
			if !reflect.DeepEqual(result[definition.Name].Rows, want) {
				t.Fatalf("rows = %#v, want %#v", result[definition.Name].Rows, want)
			}
			if !reflect.DeepEqual(client.commands, []string{"HGET", "SCARD"}) ||
				!reflect.DeepEqual(metrics.PushedDown, []string{"compute", "aggregate"}) ||
				metrics.RedisRows != 0 || metrics.PeakWorkingBytes > 1024 {
				t.Fatalf("unexpected native-count execution: commands=%v metrics=%+v", client.commands, metrics)
			}
		})
	}
}

func TestNativeTableCountRejectsChangedSemantics(t *testing.T) {
	base := query.Definition{
		Name: "count", From: "tools",
		Compute: []query.ComputedField{{
			As: "table", Function: "literal", Args: []query.Argument{{Value: "tool events"}},
		}},
		Aggregate: &query.Aggregate{
			By:     []string{"table"},
			Values: []query.AggregateValue{{Field: "event", As: "records", Reducer: "count"}},
		},
	}
	for name, mutate := range map[string]func(*query.Definition){
		"filtered": func(d *query.Definition) {
			d.Filter = &query.Filter{Predicates: []query.Predicate{{Field: "event", Equals: "call"}}}
		},
		"conditional": func(d *query.Definition) {
			d.Aggregate.Values[0].Filter = &query.Filter{Predicates: []query.Predicate{{Field: "event", Equals: "call"}}}
		},
		"other reducer": func(d *query.Definition) { d.Aggregate.Values[0].Reducer = "sum" },
		"other group":   func(d *query.Definition) { d.Aggregate.By = []string{"event"} },
		"other compute": func(d *query.Definition) { d.Compute[0].Function = "format-count" },
		"union":         func(d *query.Definition) { d.Union = []string{"other"} },
	} {
		t.Run(name, func(t *testing.T) {
			definition := base
			definition.Compute = append([]query.ComputedField(nil), base.Compute...)
			aggregate := *base.Aggregate
			aggregate.Values = append([]query.AggregateValue(nil), base.Aggregate.Values...)
			definition.Aggregate = &aggregate
			mutate(&definition)
			client := &countCommandClient{count: 2}
			store := NewStore(client, "test-count")
			_, metrics, err := store.LoadSource(t.Context(), "generation", "tools", &definition)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(client.commands, []string{"HGET", "SMEMBERS"}) ||
				len(metrics.PushedDown) != 0 {
				t.Fatalf("unsafe count pushdown: commands=%v metrics=%+v", client.commands, metrics)
			}
		})
	}
}
