package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestQueryTelemetryAttributesExcludeQueryContent(t *testing.T) {
	input := queryRequest{
		SourceNames: []string{"private-source"},
		Aliases:     []string{"private-alias"},
		Queries: []query.Definition{{
			Name: "private-query",
			From: "private-source",
			Filter: &query.Filter{Predicates: []query.Predicate{{
				Field: "private-field", Equals: "private-value",
			}}},
		}},
		RouteParameters: map[string]any{"private-route": "private-route-value"},
		QueryContext:    map[string]any{"private-context": "private-context-value"},
	}
	result := queryResponse{
		Revision: 42,
		Metrics: model.Metrics{
			DurationMS: 1200, Operations: 50, OutputRows: 2, RateLimitCost: 2,
			QueryCount: 1, FilterCount: 1,
		},
	}

	attributes := queryTelemetryAttributes(input, result)
	encoded, err := json.Marshal(attributes)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, private := range []string{
		"private-source", "private-alias", "private-query", "private-field",
		"private-value", "private-route", "private-context",
	} {
		if strings.Contains(text, private) {
			t.Fatalf("telemetry exposed private query content %q: %s", private, text)
		}
	}
	if !strings.Contains(text, "cao_dashboard.query.duration_ms") ||
		!strings.Contains(text, "cao_dashboard.query.structure.filter_count") {
		t.Fatalf("telemetry omitted performance or structural attributes: %s", text)
	}
}
