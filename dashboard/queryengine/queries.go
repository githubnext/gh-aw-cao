package queryengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type logicalSource struct {
	rows     []nativeRow
	metadata nativeRow
}

// ExecuteQueries evaluates a bounded named query graph over logical source
// arrays or envelopes ({rows, metadata}). It shares one execution budget and preserves
// explicit unavailable evidence rather than interpreting it as zero activity.
// A nil requested list selects every definition; an empty list selects none.
// Dependency-path limits exclude cached inputs already materialized by the plan.
func ExecuteQueries(ctx context.Context, definitions []map[string]any, sources map[string]any, requested []string) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if requested == nil {
		requested = make([]string, len(definitions))
		for i, definition := range definitions {
			requested[i] = engineString(definition["name"])
		}
	}
	if len(definitions) > 2048 || len(requested) > 100 {
		return nil, engineUnavailable("query batch exceeds structural resource limits")
	}
	index := map[string]nativeRow{}
	for _, definition := range definitions {
		name := engineString(definition["name"])
		if name == "" || len(name) > 200 {
			return nil, engineUnavailable("query name is required and must not exceed 200 characters")
		}
		if _, exists := index[name]; exists {
			return nil, engineUnavailable("query name %q is declared more than once", name)
		}
		if err := Validate(definition); err != nil {
			return nil, err
		}
		index[name] = definition
	}
	normalizedSources := make(map[string]any, len(sources))
	for name, input := range sources {
		document, err := normalizeQuerySource(name, input)
		if err != nil {
			return nil, err
		}
		normalizedSources[name] = document
	}
	sources = normalizedSources
	cache := map[string]logicalSource{}
	sourceKey := func(name string, input bool) string {
		if input && index[name] != nil {
			document := engineMap(sources[name])
			if document != nil && engineArray(document["rows"]) && engineMap(document["metadata"])["availability"] != "unavailable" {
				return "\x00" + name
			}
		}
		return name
	}
	visiting := map[string]bool{}
	planned := map[string]bool{}
	var preflight func(string, bool, int, int) error
	preflight = func(name string, input bool, depth, joins int) error {
		if name == "" || len(name) > 200 {
			return engineUnavailable("invalid query source name")
		}
		key := sourceKey(name, input)
		if visiting[key] {
			return engineUnavailable("query dependency cycle at %q", name)
		}
		// Cached inputs are materialized boundaries, not additional frames
		// on the currently executing dependency path.
		if planned[key] {
			return nil
		}
		visiting[key] = true
		defer delete(visiting, key)
		if definition := index[name]; definition != nil && key == name {
			depth++
			joins += len(engineList(definition["joins"]))
			if depth > 16 || joins > 16 {
				return engineUnavailable("query dependency graph exceeds depth or join limits")
			}
			for _, input := range queryInputs(definition) {
				if err := preflight(input, true, depth, joins); err != nil {
					return err
				}
			}
		}
		planned[key] = true
		if len(planned) > 256 {
			return engineUnavailable("query dependency graph exceeds max plan sources (256)")
		}
		return nil
	}
	for _, name := range requested {
		if err := preflight(name, false, 0, 0); err != nil {
			return nil, err
		}
	}
	session := NewSession(ctx, Options{})
	retainedRows, retainedBytes := 0, 0
	var resolve func(string, bool) (logicalSource, error)
	resolve = func(name string, input bool) (logicalSource, error) {
		if err := ctx.Err(); err != nil {
			return logicalSource{}, err
		}
		key := sourceKey(name, input)
		if value, present := cache[key]; present {
			return value, nil
		}
		var result logicalSource
		if definition := index[name]; definition != nil && key == name {
			inputs := map[string]logicalSource{}
			optional := map[string]bool{}
			for _, item := range engineList(definition["joins"]) {
				join := engineMap(item)
				if join["type"] == "left" {
					optional[engineString(join["source"])] = true
				}
			}
			for _, input := range queryInputs(definition) {
				value, err := resolve(input, true)
				if err != nil {
					var unavailable *NativeQueryUnavailableError
					if !optional[input] || !errors.As(err, &unavailable) {
						return logicalSource{}, err
					}
					value = logicalSource{rows: []nativeRow{}, metadata: nativeRow{"availability": "unavailable", "error": err.Error()}}
				}
				inputs[input] = value
			}
			result.metadata = querySourceMetadata(name, definition, inputs)
			result.rows = []nativeRow{}
			if result.metadata["availability"] != "unavailable" {
				rows, err := session.Execute(definition, func(input string) ([]map[string]any, error) {
					return inputs[input].rows, nil
				})
				if err != nil {
					return logicalSource{}, err
				}
				result.rows = rows
				result.metadata["availability"] = "empty"
				if len(rows) > 0 {
					result.metadata["availability"] = "available"
				}
			}
		} else {
			document := engineMap(sources[name])
			if document == nil || !engineArray(document["rows"]) {
				return logicalSource{}, &NativeQueryUnavailableError{Source: name, Reason: "input source is unavailable"}
			}
			result.rows = []nativeRow{}
			for _, item := range engineList(document["rows"]) {
				row := engineMap(item)
				if row == nil {
					return logicalSource{}, engineUnavailable("input source %q contains a non-object row", name)
				}
				result.rows = append(result.rows, engineClone(row))
			}
			result.metadata = engineClone(engineMap(document["metadata"]))
			if result.metadata == nil {
				result.metadata = nativeRow{}
			}
			if result.metadata["availability"] == "unavailable" {
				result.rows = []nativeRow{}
			}
		}
		if len(result.rows) > engineMaxInputRows {
			return logicalSource{}, engineUnavailable("source %q exceeds max input rows", name)
		}
		retainedRows += len(result.rows)
		content, err := json.Marshal(result.rows)
		if err != nil {
			return logicalSource{}, fmt.Errorf("encode query source %q: %w", name, err)
		}
		retainedBytes += len(content)
		if retainedRows > 500000 || retainedBytes > 512<<20 {
			return logicalSource{}, engineUnavailable("query graph exceeds retained data limits")
		}
		cache[key] = result
		return result, nil
	}
	output := map[string]any{}
	for _, name := range requested {
		result, err := resolve(name, false)
		if err != nil {
			return nil, err
		}
		if len(result.rows) > engineMaxOutputRows {
			return nil, engineUnavailable("source %q exceeds max output rows", name)
		}
		output[name] = nativeRow{"source": name, "rows": result.rows, "metadata": result.metadata}
	}
	return output, nil
}

func normalizeQuerySource(name string, input any) (nativeRow, error) {
	document := engineMap(input)
	if engineArray(input) {
		document = nativeRow{"rows": input}
	}
	if document == nil || !engineArray(document["rows"]) {
		return nil, engineUnavailable("logical source %q must be an array or an object with a rows array", name)
	}
	metadata := nativeRow{
		"source-id": name, "availability": "available", "completeness": "complete", "freshness": "unknown",
	}
	for field, value := range engineMap(document["metadata"]) {
		metadata[field] = value
	}
	normalized := engineClone(document)
	if _, ok := normalized["source"].(string); !ok {
		normalized["source"] = name
	}
	normalized["metadata"] = metadata
	return normalized, nil
}

func queryInputs(definition nativeRow) []string {
	inputs := []string{engineString(definition["from"])}
	inputs = append(inputs, engineFields(definition["union"])...)
	for _, item := range engineList(definition["joins"]) {
		inputs = append(inputs, engineString(engineMap(item)["source"]))
	}
	return inputs
}

func querySourceMetadata(name string, definition nativeRow, inputs map[string]logicalSource) nativeRow {
	result := nativeRow{
		"source-id": name + "-query", "source-kind": "derived", "query-name": name,
		"as-of": "1970-01-01T00:00:00.000Z", "retrieved-at": "1970-01-01T00:00:00.000Z",
		"completeness": "complete", "freshness": "fresh", "availability": "available",
	}
	optional := map[string]bool{}
	for _, item := range engineList(definition["joins"]) {
		join := engineMap(item)
		if join["type"] == "left" {
			optional[engineString(join["source"])] = true
		}
	}
	partial, unknown, stale, unknownFresh, unavailableOptional := false, false, false, false, false
	oldest := map[string]float64{}
	for _, input := range queryInputs(definition) {
		metadata := inputs[input].metadata
		if metadata["availability"] == "unavailable" {
			if optional[input] {
				unavailableOptional = true
			} else {
				result["availability"] = "unavailable"
				if message, present := metadata["error"]; present {
					result["error"] = message
				}
			}
		}
		partial = partial || metadata["completeness"] == "partial"
		unknown = unknown || metadata["completeness"] != "complete"
		stale = stale || metadata["freshness"] == "stale"
		unknownFresh = unknownFresh || metadata["freshness"] != "fresh"
		for _, field := range []string{"as-of", "retrieved-at"} {
			if timestamp, valid := engineParseDate(metadata[field]); valid {
				if before, present := oldest[field]; !present || timestamp < before {
					oldest[field], result[field] = timestamp, metadata[field]
				}
			}
		}
	}
	if partial || unavailableOptional {
		result["completeness"] = "partial"
	} else if unknown {
		result["completeness"] = "unknown"
	}
	if stale {
		result["freshness"] = "stale"
	} else if unknownFresh {
		result["freshness"] = "unknown"
	}
	return result
}
