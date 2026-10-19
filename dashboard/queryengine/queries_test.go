package queryengine

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestExecuteQueriesNamedGraphAndMetadata(t *testing.T) {
	var definitions []map[string]any
	if err := json.Unmarshal([]byte(`[
		{"name":"selected","from":"input","select":[{"field":"id"},{"field":"explicit"},{"field":"missing"}]},
		{"name":"joined","from":"selected","joins":[{"source":"optional","type":"left","on":[{"left":"id","right":"id"}],"fields":[{"field":"value","as":"value"}]}]}
	]`), &definitions); err != nil {
		t.Fatal(err)
	}
	metadata := map[string]any{
		"as-of": "2026-10-18T10:00:00Z", "retrieved-at": "2026-10-18T11:00:00Z",
		"availability": "available", "completeness": "complete", "freshness": "fresh",
		"custom": "preserved",
	}
	sources := map[string]any{"input": map[string]any{
		"rows": []map[string]any{{"id": "one", "explicit": nil}}, "metadata": metadata,
	}}
	result, err := ExecuteQueries(context.Background(), definitions, sources, []string{"joined", "input"})
	if err != nil {
		t.Fatal(err)
	}
	joined := engineMap(result["joined"])
	engineTestEqual(t, joined["rows"], []nativeRow{{"id": "one", "explicit": nil, "value": nil}})
	composed := engineMap(joined["metadata"])
	if composed["completeness"] != "partial" || composed["availability"] != "available" ||
		composed["as-of"] != metadata["as-of"] || composed["query-name"] != "joined" {
		t.Fatalf("composed metadata: %#v", composed)
	}
	expectedMetadata := engineClone(metadata)
	expectedMetadata["source-id"] = "input"
	engineTestEqual(t, engineMap(result["input"])["metadata"], expectedMetadata)
}

func TestExecuteQueriesUnavailableDoesNotBecomeZero(t *testing.T) {
	definitions := []map[string]any{{
		"name": "count", "from": "input",
		"aggregate": map[string]any{"values": []any{map[string]any{"field": "id", "as": "count", "reducer": "count"}}},
	}}
	result, err := ExecuteQueries(context.Background(), definitions, map[string]any{
		"input": map[string]any{"rows": []any{}, "metadata": map[string]any{"availability": "unavailable", "error": "not collected"}},
	}, []string{"count"})
	if err != nil {
		t.Fatal(err)
	}
	source := engineMap(result["count"])
	engineTestEqual(t, source["rows"], []nativeRow{})
	if metadata := engineMap(source["metadata"]); metadata["availability"] != "unavailable" || metadata["error"] != "not collected" {
		t.Fatalf("unavailability lost: %#v", metadata)
	}
	if _, err := ExecuteQueries(context.Background(), definitions, nil, []string{"count"}); err == nil {
		t.Fatal("unknown source accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ExecuteQueries(ctx, nil, nil, []string{"unknown"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if _, err := ExecuteQueries(context.Background(), []map[string]any{{"name": "cycle", "from": "cycle"}}, nil, []string{"cycle"}); err == nil {
		t.Fatal("cycle accepted")
	}
}

func TestExecuteQueriesUsesSuppliedPrecomputedInputs(t *testing.T) {
	sources := map[string]any{
		"rows": nativeRow{"rows": []nativeRow{{"id": "one"}}, "metadata": nativeRow{"availability": "available"}},
	}
	definitions := []map[string]any{{"name": "rows", "from": "rows", "select": []any{nativeRow{"field": "id"}}}}
	result, err := ExecuteQueries(context.Background(), definitions, sources, []string{"rows"})
	if err != nil {
		t.Fatal(err)
	}
	engineTestEqual(t, engineMap(result["rows"])["rows"], []nativeRow{{"id": "one"}})
}

func TestExecuteQueriesDefaultsOnlyNilRequestedToAllDefinitions(t *testing.T) {
	definitions := []map[string]any{
		{"name": "first", "from": "input"},
		{"name": "second", "from": "first"},
	}

	sources := map[string]any{
		"input": nativeRow{"rows": []nativeRow{{"id": "one"}}, "metadata": nativeRow{"availability": "available"}},
	}
	for _, test := range []struct {
		name      string
		requested []string
		expected  []string
	}{
		{name: "omitted", requested: nil, expected: []string{"first", "second"}},
		{name: "empty", requested: []string{}, expected: []string{}},
		{name: "selected", requested: []string{"second"}, expected: []string{"second"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := ExecuteQueries(t.Context(), definitions, sources, test.requested)
			if err != nil {
				t.Fatal(err)
			}
			if len(result) != len(test.expected) {
				t.Fatalf("returned %d sources, expected %d: %#v", len(result), len(test.expected), result)
			}
			for _, name := range test.expected {
				engineTestEqual(t, engineMap(result[name])["rows"], []nativeRow{{"id": "one"}})
			}
		})
	}
}

func TestExecuteQueriesNormalizesArraysAndOptionalMetadata(t *testing.T) {
	rows := []nativeRow{{"id": "one"}}
	for _, test := range []struct {
		name         string
		input        any
		availability string
		completeness string
		expected     []nativeRow
	}{
		{name: "array", input: rows, availability: "available", completeness: "complete", expected: rows},
		{name: "envelope", input: nativeRow{"rows": rows}, availability: "available", completeness: "complete", expected: rows},
		{name: "partial metadata", input: nativeRow{"rows": rows, "metadata": nativeRow{"completeness": "partial"}}, availability: "available", completeness: "partial", expected: rows},
		{name: "unavailable", input: nativeRow{"rows": rows, "metadata": nativeRow{"availability": "unavailable", "error": "not collected"}}, availability: "unavailable", completeness: "complete", expected: []nativeRow{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := ExecuteQueries(t.Context(), []map[string]any{{"name": "selected", "from": "input"}},
				map[string]any{"input": test.input}, []string{"input", "selected"})
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"input", "selected"} {
				source := engineMap(result[name])
				engineTestEqual(t, source["rows"], test.expected)
				metadata := engineMap(source["metadata"])
				if metadata["availability"] != test.availability || metadata["completeness"] != test.completeness || metadata["freshness"] != "unknown" {
					t.Fatalf("source %s metadata: %#v", name, metadata)
				}
			}
			if engineMap(engineMap(result["input"])["metadata"])["source-id"] != "input" {
				t.Fatal("source identity default was omitted")
			}
			if test.availability == "unavailable" && engineMap(engineMap(result["selected"])["metadata"])["error"] != "not collected" {
				t.Fatal("explicit unavailability was lost")
			}
		})
	}
	result, err := ExecuteQueries(t.Context(), []map[string]any{{"name": "input", "from": "input"}},
		map[string]any{"input": rows}, nil)
	if err != nil {
		t.Fatal(err)
	}
	engineTestEqual(t, engineMap(result["input"])["rows"], rows)
}
