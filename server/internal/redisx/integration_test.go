package redisx

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestRedisStackIntegration(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}

	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespaceName := "integration-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	namespace, err := NormalizeNamespace(namespaceName)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, namespace)
	otherStore := NewStore(client, namespaceName+"-other")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	generation := "integration-" + time.Now().UTC().Format("20060102150405.000000000")
	source := model.Source{
		Source:   "integration-runs",
		Rows:     []model.Row{{"id": "1", "conclusion": "success", "duration": 5}},
		Metadata: model.Metadata{"availability": "available"},
	}
	if _, err := store.PutSource(ctx, generation, source); err != nil {
		t.Fatal(err)
	}
	otherSource := source
	otherSource.Rows = []model.Row{{"id": "1", "conclusion": "failure", "duration": 8}}
	if _, err := otherStore.PutSource(ctx, generation, otherSource); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(
		ctx, generation, "integration-revision", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		map[string]int{"integration-runs": 1},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := otherStore.Activate(
		ctx, generation, "other-integration-revision", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		map[string]int{"integration-runs": 1},
	); err != nil {
		t.Fatal(err)
	}
	active, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	otherActive, err := otherStore.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if active.Revision != 1 || active.DataRevision != "integration-revision" {
		t.Fatalf("unexpected first namespace active state: %#v", active)
	}
	if otherActive.Revision != 1 || otherActive.DataRevision != "other-integration-revision" {
		t.Fatalf("unexpected second namespace active state: %#v", otherActive)
	}
	loaded, _, err := store.LoadSource(ctx, generation, "integration-runs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Rows) != 1 || loaded.Rows[0]["conclusion"] != "success" {
		t.Fatalf("unexpected Redis rows: %#v", loaded.Rows)
	}
	otherLoaded, _, err := otherStore.LoadSource(ctx, generation, "integration-runs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(otherLoaded.Rows) != 1 || otherLoaded.Rows[0]["conclusion"] != "failure" {
		t.Fatalf("unexpected namespaced Redis rows: %#v", otherLoaded.Rows)
	}
}

func TestRedisSearchFailurePreservesResidualQuery(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := NormalizeNamespace("search-fallback-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	generation := "search-fallback"
	source := model.Source{
		Source: "runs",
		Rows: []model.Row{
			{"id": "1", "conclusion": "success"},
			{"id": "2", "conclusion": "failure"},
		},
	}
	if _, err := store.PutSource(ctx, generation, source); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(ctx, "FT.DROPINDEX", store.indexName(generation, "runs")); err != nil {
		t.Fatal(err)
	}
	definition := query.Definition{
		Name: "failures",
		From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{
			Field: "conclusion",
			In:    []any{"failure"},
		}}},
	}
	loaded, metrics, err := store.LoadSource(ctx, generation, "runs", &definition)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Rows) != 2 {
		t.Fatalf("got %d fallback rows, want 2", len(loaded.Rows))
	}
	if len(metrics.PushedDown) != 0 {
		t.Fatalf("failed Redis search reported pushed-down operations: %#v", metrics.PushedDown)
	}
}
