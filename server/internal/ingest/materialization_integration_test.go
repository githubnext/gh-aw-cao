package ingest

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestRunMaterializesGeneratedDashboardQueries(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := redisx.NormalizeNamespace("materialize-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, namespace)
	content, err := os.ReadFile("../../../dashboard/site/src/agent/queries.generated.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	result, err := Run(ctx, store, "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		DashboardQueries:    definitions,
		Force:               true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_ = store.DiscardGeneration(cleanup, result.Generation)
	})
	definition := findQueryDefinition(definitions, "event-base")
	if definition == nil {
		t.Fatal("generated event-base query is missing")
	}
	materialized, metrics, err := store.ExecutePlan(
		ctx, result.Generation, definitions, []string{definition.Name},
		[]string{"audits", "domains", "tools", "issues", definition.Name}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if materialized[definition.Name].Metadata[query.MaterializedSignatureMetadata] == "" {
		t.Fatalf("event-base was not materialized: %#v", materialized[definition.Name].Metadata)
	}
	if len(metrics.PushedDown) != 1 || metrics.PushedDown[0] != "redis-materialized-query" {
		t.Fatalf("event-base was not loaded natively: %+v", metrics)
	}
	changed := append([]query.Definition(nil), definitions...)
	changedDefinition := findQueryDefinition(changed, "event-base")
	limit := query.MaxOutputRows - 1
	changedDefinition.Limit = &limit
	updated, err := Run(ctx, store, "../../testdata/deployed-subset", Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
		DashboardQueries:    changed,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_ = store.DiscardGeneration(cleanup, updated.Generation)
	})
	if updated.Generation == result.Generation || updated.DataRevision == result.DataRevision {
		t.Fatalf("changed query catalog reused generation: before=%+v after=%+v", result, updated)
	}
}

func findQueryDefinition(definitions []query.Definition, name string) *query.Definition {
	for index := range definitions {
		if definitions[index].Name == name {
			return &definitions[index]
		}
	}
	return nil
}
