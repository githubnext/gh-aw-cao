package redisx

import (
	"context"
	"os"
	"reflect"
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
	reset := time.Now().Add(time.Hour).Unix()
	if err := store.HashSet(ctx, "test-budget", "1", "120|"+strconv.FormatInt(reset, 10)+"|0"); err != nil {
		t.Fatal(err)
	}
	for index, expected := range []int{0, 0, 2} {
		result, err := store.ReserveRateLimit(ctx, "test-budget", "1", 100, 10, time.Now().Unix())
		if err != nil {
			t.Fatal(err)
		}
		if result != expected {
			t.Fatalf("reservation %d = %d, want %d", index, result, expected)
		}
	}
	generation := "integration-" + time.Now().UTC().Format("20060102150405.000000000")
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = store.DropGeneration(cleanup, generation)
		_ = otherStore.DropGeneration(cleanup, generation)
	})
	source := model.Source{
		Source:   "integration-runs",
		Rows:     []model.Row{{"id": "1", "conclusion": "success", "duration": 5}},
		Metadata: model.Metadata{"availability": "available"},
	}
	if err := store.PutSource(ctx, generation, source); err != nil {
		t.Fatal(err)
	}
	otherSource := source
	otherSource.Rows = []model.Row{{"id": "1", "conclusion": "failure", "duration": 8}}
	if err := otherStore.PutSource(ctx, generation, otherSource); err != nil {
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

func TestRedisJSONSearchIndexAndFallback(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := NormalizeNamespace("json-search-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	generation := "generation"
	aggregateDefinition := query.Definition{
		Name: "duration-summary", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "duration", GTE: 2, LT: 4}}},
		Aggregate: &query.Aggregate{
			By: []string{"conclusion"},
			Values: []query.AggregateValue{
				{Field: "conclusion", As: "runs", Reducer: "count"},
				{Field: "duration", As: "mean-duration", Reducer: "mean"},
			},
		},
		Select:  []query.SelectedField{{Field: "conclusion"}, {Field: "runs"}, {Field: "mean-duration"}},
		OrderBy: []query.OrderField{{Field: "mean-duration", Direction: "desc"}},
	}
	store.ConfigureIndexDefinitions([]query.Definition{aggregateDefinition})
	source := model.Source{
		Source: "runs",
		Rows: []model.Row{
			{"id": "1", "conclusion": "success", "duration": 1.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
			{"id": "2", "conclusion": "failure", "duration": 2.0, "workflow-role": "orchestrator", "repositoryFullName": "owner/repo-b"},
			{"id": "3", "conclusion": "failure", "duration": 3.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
			{"id": 4, "conclusion": "success", "duration": 4.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
		},
	}
	if err := store.PutSource(ctx, generation, source); err != nil {
		t.Fatal(err)
	}
	members, err := client.Do(ctx, "SMEMBERS", store.sourceSetKey(generation, "runs"))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := Strings(members)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 4 {
		t.Fatalf("got %d row keys, want 4", len(keys))
	}
	for _, key := range keys {
		value, err := client.Do(ctx, "TYPE", key)
		if err != nil {
			t.Fatal(err)
		}
		if value != "ReJSON-RL" {
			t.Fatalf("row has type %v, want RedisJSON", value)
		}
	}
	definition := query.Definition{
		Name: "failures",
		From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "conclusion", In: []any{"failure"}},
			{Field: "workflow-role", Equals: "worker"},
		}},
	}
	loaded, metrics, err := store.LoadSource(ctx, generation, "runs", &definition)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Rows) != 2 {
		t.Fatalf("got %d candidate rows, want two failures", len(loaded.Rows))
	}
	if len(metrics.PushedDown) != 1 || metrics.PushedDown[0] != "indexed-candidates" || metrics.RedisRows != 2 {
		t.Fatalf("index not used: %+v", metrics)
	}
	results, _, err := query.New(storeQueryLoader{store, ctx}).Execute([]query.Definition{definition}, []string{"failures"})
	if err != nil {
		t.Fatal(err)
	}
	if len(results["failures"].Rows) != 1 || results["failures"].Rows[0]["id"] != "3" {
		t.Fatalf("residual predicate not applied: %#v", results["failures"].Rows)
	}
	limit := 1
	nativeDefinition := definition
	nativeDefinition.Name = "native-failures"
	nativeDefinition.Compute = []query.ComputedField{{
		As: "label", Function: "literal", Args: []query.Argument{{Value: "failed worker"}},
	}}
	nativeDefinition.Select = []query.SelectedField{{Field: "id"}, {Field: "label"}}
	nativeDefinition.OrderBy = []query.OrderField{{Field: "id", Direction: "desc"}}
	nativeDefinition.Limit = &limit
	native, nativeMetrics, err := store.ExecutePlan(
		ctx, generation, []query.Definition{nativeDefinition}, []string{nativeDefinition.Name},
		[]string{"runs", nativeDefinition.Name}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(native[nativeDefinition.Name].Rows) != 1 || native[nativeDefinition.Name].Rows[0]["id"] != "3" ||
		native[nativeDefinition.Name].Rows[0]["label"] != "failed worker" {
		t.Fatalf("unexpected Redis-native rows: %#v", native[nativeDefinition.Name].Rows)
	}
	if len(nativeMetrics.FallbackOperations) != 0 ||
		len(nativeMetrics.PushedDown) != 1 || nativeMetrics.PushedDown[0] != "redis-query-engine" {
		t.Fatalf("query plan was not fully executed in Redis: %+v", nativeMetrics)
	}
	aggregated, aggregateMetrics, err := store.ExecutePlan(
		ctx, generation, []query.Definition{aggregateDefinition}, []string{aggregateDefinition.Name},
		[]string{"runs", aggregateDefinition.Name}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	aggregateRows := aggregated[aggregateDefinition.Name].Rows
	if len(aggregateRows) != 1 || aggregateRows[0]["conclusion"] != "failure" ||
		aggregateRows[0]["runs"] != 2.0 || aggregateRows[0]["mean-duration"] != 2.5 {
		t.Fatalf("unexpected Redis-native aggregate rows: %#v", aggregateRows)
	}
	if len(aggregateMetrics.FallbackOperations) != 0 ||
		!reflect.DeepEqual(aggregateMetrics.PushedDown, []string{"redis-query-engine"}) {
		t.Fatalf("aggregate plan was not fully executed in Redis: %+v", aggregateMetrics)
	}
	byRole := query.Definition{
		Name: "workers", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "workflow-role", Equals: "worker"}}},
	}
	loaded, metrics, err = store.LoadSource(ctx, generation, "runs", &byRole)
	if err != nil || len(loaded.Rows) != 3 || len(metrics.PushedDown) != 1 {
		t.Fatalf("hyphenated JSON field was not indexed: rows=%d metrics=%+v err=%v", len(loaded.Rows), metrics, err)
	}
	byRepository := query.Definition{
		Name: "repository-runs", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "repositoryFullName", Equals: "owner/repo-a"}}},
	}
	loaded, metrics, err = store.LoadSource(ctx, generation, "runs", &byRepository)
	if err != nil || len(loaded.Rows) != 3 || len(metrics.PushedDown) != 1 {
		t.Fatalf("escaped repository tag was not indexed: rows=%d metrics=%+v err=%v", len(loaded.Rows), metrics, err)
	}
	unsafe := definition
	unsafe.Filter = &query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "unknown"}}}
	loaded, metrics, err = store.LoadSource(ctx, generation, "runs", &unsafe)
	if err != nil || len(loaded.Rows) != 4 || len(metrics.PushedDown) != 0 {
		t.Fatalf("unsupported filter did not fall back: rows=%d metrics=%+v err=%v", len(loaded.Rows), metrics, err)
	}

	countDefinition := query.Definition{
		Name: "runs-table-count", From: "runs",
		Compute: []query.ComputedField{{
			As: "table", Function: "literal", Args: []query.Argument{{Value: "workflow runs"}},
		}},
		Aggregate: &query.Aggregate{
			By:     []string{"table"},
			Values: []query.AggregateValue{{Field: "table", As: "records", Reducer: "count"}},
		},
	}
	counted, countMetrics, err := store.LoadSource(ctx, generation, "runs", &countDefinition)
	if err != nil {
		t.Fatal(err)
	}
	if len(counted.Rows) != 1 || counted.Rows[0]["records"] != 4 ||
		countMetrics.RedisRows != 0 || countMetrics.RedisCommands != 2 {
		t.Fatalf("unexpected Redis native count: rows=%#v metrics=%+v", counted.Rows, countMetrics)
	}
	if err := store.DropGeneration(ctx, generation); err != nil {
		t.Fatal(err)
	}
	if err := store.DropGeneration(ctx, generation); err != nil {
		t.Fatalf("generation cleanup is not idempotent: %v", err)
	}
	for _, key := range keys {
		value, err := client.Do(ctx, "EXISTS", key)
		if err != nil || value != int64(0) {
			t.Fatalf("row remains after dropping generation: %v %v", value, err)
		}
	}
	if err := store.PutSource(ctx, "numeric-only", model.Source{
		Source: "numeric", Rows: []model.Row{{"id": 5, "observed-runs": 1}},
	}); err != nil {
		t.Fatal(err)
	}
	numeric, _, err := store.LoadSource(ctx, "numeric-only", "numeric", nil)
	if err != nil || len(numeric.Rows) != 1 {
		t.Fatalf("unindexed JSON source was not readable: %#v %v", numeric.Rows, err)
	}
	if err := store.DropGeneration(ctx, "numeric-only"); err != nil {
		t.Fatalf("unindexed JSON source was not reclaimed: %v", err)
	}
}

func TestLegacyAndUpstashHashSourcesRemainReadable(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewProcessIsolatedStore(client, "integration-hash")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = store.DropGeneration(cleanup, "generation")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	source := model.Source{
		Source: "runs", Rows: []model.Row{{"id": "1", "conclusion": "success"}, {"id": "2", "conclusion": "failure"}},
	}
	if err := store.PutSource(ctx, "generation", source); err != nil {
		t.Fatal(err)
	}
	keys, err := client.Do(ctx, "SMEMBERS", store.sourceSetKey("generation", "runs"))
	if err != nil {
		t.Fatal(err)
	}
	members, err := Strings(keys)
	if err != nil || len(members) != 2 {
		t.Fatalf("unexpected row keys: %v %v", members, err)
	}
	for _, key := range members {
		kind, err := client.Do(ctx, "TYPE", key)
		if err != nil || kind != "hash" {
			t.Fatalf("Upstash row is not a hash: %v %v", kind, err)
		}
	}
	definition := query.Definition{
		Name: "failures", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "failure"}}},
	}
	loaded, metrics, err := store.LoadSource(ctx, "generation", "runs", &definition)
	if err != nil || len(loaded.Rows) != 2 || len(metrics.PushedDown) != 0 {
		t.Fatalf("Upstash hash fallback failed: rows=%d metrics=%+v err=%v", len(loaded.Rows), metrics, err)
	}
	// An earlier deployment has metadata and hash rows but no format marker.
	if _, err := client.Do(ctx, "HDEL", store.generationKey("generation"), "source:runs:format"); err != nil {
		t.Fatal(err)
	}
	loaded, metrics, err = store.LoadSource(ctx, "generation", "runs", &definition)
	if err != nil || len(loaded.Rows) != 2 || len(metrics.PushedDown) != 0 {
		t.Fatalf("legacy hash fallback failed: rows=%d metrics=%+v err=%v", len(loaded.Rows), metrics, err)
	}
}
