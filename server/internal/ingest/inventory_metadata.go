package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/githubnext/gh-cao/server/internal/model"
)

// ReadInventoryMetadata reads only published inventory quality. It neither
// imports source rows nor substitutes inventory projections for canonical data.
func ReadInventoryMetadata(ctx context.Context, path string) (map[string]model.Metadata, error) {
	file, err := os.Open(path) // #nosec G304 -- fixed filename in the operator-selected downloaded artifact.
	if errors.Is(err, os.ErrNotExist) {
		return map[string]model.Metadata{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	budget := &boundedJSONReader{reader: file, remaining: maxJSONRecordBytes}
	decoder := json.NewDecoder(budget)
	result := map[string]model.Metadata{}
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("inventory metadata requires a source object")
	}
	for decoder.More() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		budget.remaining = maxJSONRecordBytes
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, _ := key.(string)
		if name != "campaigns" && name != "repositories" && name != "workflows" {
			if err := skipValue(decoder, budget); err != nil {
				return nil, err
			}
			continue
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if token == json.Delim('[') {
			for decoder.More() {
				if err := skipValue(decoder, budget); err != nil {
					return nil, err
				}
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			continue
		}
		if token != json.Delim('{') {
			return nil, errors.New("invalid inventory quality envelope")
		}
		for decoder.More() {
			budget.remaining = maxJSONRecordBytes
			field, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			if field != "metadata" {
				if err := skipValue(decoder, budget); err != nil {
					return nil, err
				}
				continue
			}
			var metadata model.Metadata
			if err := decoder.Decode(&metadata); err != nil {
				return nil, err
			}
			quality := model.Metadata{}
			for _, key := range []string{"availability", "completeness", "freshness", "as-of"} {
				if value, ok := metadata[key].(string); ok {
					quality[key] = value
				}
			}
			result["$"+name] = quality
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("inventory metadata contains trailing JSON")
	}
	return result, nil
}
