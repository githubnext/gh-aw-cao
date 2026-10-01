package server

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type changingDatasetClient struct{}

func (changingDatasetClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "HGETALL":
		return []any{"revision", "1", "counts", `{"runs":1}`, "dataRevision", "first"}, nil
	case "HGET":
		if command[2] == "revision" {
			return "2", nil
		}
		return `{"source-id":"runs"}`, nil
	case "EVAL":
		return []any{"0", []any{"_staged", "1", "id-1", `{"id":"id-1"}`}}, nil
	default:
		return nil, errors.New("unexpected Redis command")
	}
}

func (changingDatasetClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestQueryRejectsDatasetReplacementDuringSourceRead(t *testing.T) {
	app := &App{store: redisx.NewStore(changingDatasetClient{}, "read-fence")}
	result, status, err := app.executeQuery(t.Context(), queryRequest{SourceNames: []string{"runs"}}, false)
	if status != http.StatusServiceUnavailable || err == nil || len(result.Sources) != 0 {
		t.Fatalf("mixed dataset query returned status=%d result=%+v err=%v", status, result, err)
	}
}

type rebuildingIndexClient struct{}

func (rebuildingIndexClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "HGETALL":
		return []any{"revision", "1", "counts", `{"runs":1}`, "dataRevision", "first"}, nil
	case "HGET":
		if command[2] == "revision" {
			return "1", nil
		}
		return `{"source-id":"runs"}`, nil
	case "HMGET":
		return []any{nil, `["conclusion"]`, nil}, nil
	default:
		return nil, errors.New("index-not-ready query attempted a Redis source scan")
	}
}

func (rebuildingIndexClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestQueryReturnsServiceUnavailableUntilIndexRebuildCompletes(t *testing.T) {
	app := &App{store: redisx.NewStore(rebuildingIndexClient{}, "read-fence")}
	definition := query.Definition{Name: "failures", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "conclusion", Equals: "failure"},
		}}}
	result, status, err := app.executeQuery(t.Context(), queryRequest{
		SourceNames: []string{"runs"}, Aliases: []string{definition.Name},
		Queries: []query.Definition{definition},
	}, false)
	if status != http.StatusServiceUnavailable || !errors.Is(err, redisx.ErrSearchIndexUnavailable) ||
		len(result.Sources) != 0 {
		t.Fatalf("indexed query used canonical fallback: status=%d sources=%+v err=%v",
			status, result.Sources, err)
	}
}
