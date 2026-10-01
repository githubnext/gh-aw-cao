package redisx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type rejectIndexCreation struct{ CommandClient }

type interruptIndexedRead struct {
	CommandClient
	datasetKey string
}

func (client interruptIndexedRead) Do(ctx context.Context, command ...string) (any, error) {
	value, err := client.CommandClient.Do(ctx, command...)
	if err == nil && command[0] == "FT.SEARCH" {
		_, err = client.CommandClient.Do(ctx, "HINCRBY", client.datasetKey, "indexedEpoch", "1")
	}
	return value, err
}

func (client rejectIndexCreation) Do(ctx context.Context, command ...string) (any, error) {
	if command[0] == "FT.CREATE" {
		return nil, errors.New("simulated indexing interruption")
	}
	return client.CommandClient.Do(ctx, command...)
}

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
	stage, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	otherStage, err := otherStore.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = store.DiscardDataset(cleanup, stage)
		_ = otherStore.DiscardDataset(cleanup, otherStage)
	})
	source := model.Source{
		Source:   "integration-runs",
		Rows:     []model.Row{{"id": "1", "conclusion": "success", "duration": 5, "future-field": map[string]any{"nested": true}}},
		Metadata: model.Metadata{"availability": "available"},
	}
	if err := store.StageSource(ctx, stage, source); err != nil {
		t.Fatal(err)
	}
	otherSource := source
	otherSource.Rows = []model.Row{{"id": "1", "conclusion": "failure", "duration": 8}}
	if err := otherStore.StageSource(ctx, otherStage, otherSource); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(
		ctx, stage, "integration-revision", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		map[string]int{"integration-runs": 1},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := otherStore.PublishDataset(
		ctx, otherStage, "other-integration-revision", time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		map[string]int{"integration-runs": 1},
	); err != nil {
		t.Fatal(err)
	}
	for _, indexedStore := range []*Store{store, otherStore} {
		if err := indexedStore.RebuildSearchIndexes(ctx, 1, map[string]int{"integration-runs": 1}); err != nil {
			t.Fatal(err)
		}
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
	loaded, _, err := store.ReadSource(ctx, "integration-runs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Rows) != 1 || loaded.Rows[0]["conclusion"] != "success" {
		t.Fatalf("unexpected Redis rows: %#v", loaded.Rows)
	}
	preserveDefinition := query.Definition{
		Name: "full-row", From: "integration-runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "success"}}},
	}
	candidates, _, err := store.ReadSource(ctx, "integration-runs", &preserveDefinition)
	if err != nil {
		t.Fatal(err)
	}
	preserved, _, _, err := query.ExecuteDefinition(preserveDefinition,
		map[string]model.Source{"integration-runs": candidates}, query.MaxOperations)
	if err != nil {
		t.Fatal(err)
	}
	if field, ok := preserved.Rows[0]["future-field"].(map[string]any); !ok || field["nested"] != true {
		t.Fatalf("no-select query discarded a future source field: %#v", preserved.Rows)
	}
	otherLoaded, _, err := otherStore.ReadSource(ctx, "integration-runs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(otherLoaded.Rows) != 1 || otherLoaded.Rows[0]["conclusion"] != "failure" {
		t.Fatalf("unexpected namespaced Redis rows: %#v", otherLoaded.Rows)
	}
}

func TestDatasetPublicationReplacesRowsAndRejectsStaleStages(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}

	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "dataset-lifecycle-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	ctx := t.Context()
	first, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stage := func(token, id string) {
		t.Helper()
		if err := store.StageSource(ctx, token, model.Source{Source: "runs",
			Rows: []model.Row{{"id": id}}, Metadata: model.Metadata{"source-id": "runs"}}); err != nil {
			t.Fatal(err)
		}
	}
	stage(first, "old")
	stage(stale, "stale")
	if err := store.StageSource(ctx, first, model.Source{Source: "jobs", Metadata: model.Metadata{"source-id": "jobs"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(ctx, first, "first", time.Now(), map[string]int{"runs": 1, "jobs": 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(ctx, stale, "stale", time.Now(), map[string]int{"runs": 1}); err == nil {
		t.Fatal("concurrent stale projection replaced the dataset")
	}
	if err := store.DiscardDataset(ctx, stale); err != nil {
		t.Fatal(err)
	}
	second, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stage(second, "new")
	if _, err := store.PublishDataset(ctx, second, "second", time.Now(), map[string]int{"runs": 1}); err != nil {
		t.Fatal(err)
	}
	loaded, _, err := store.ReadSource(ctx, "runs", nil)
	if err != nil || len(loaded.Rows) != 1 || loaded.Rows[0]["id"] != "new" {
		t.Fatalf("old rows survived replacement: %+v (%v)", loaded.Rows, err)
	}
	if count, err := client.Do(ctx, "HLEN", store.sourceHashKey("runs")); err != nil || count != int64(2) {
		t.Fatalf("replacement retained unexpected rows: %v (%v)", count, err)
	}
	if exists, err := client.Do(ctx, "EXISTS", store.sourceHashKey("jobs")); err != nil || exists != int64(0) {
		t.Fatalf("removed source key leaked: %v (%v)", exists, err)
	}
	if exists, err := client.Do(ctx, "EXISTS", store.stagingKey(stale), store.stagingSourceKey(stale, "runs")); err != nil || exists != int64(0) {
		t.Fatalf("failed staging keys leaked: %v (%v)", exists, err)
	}
	incomplete, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stage(incomplete, "missing")
	if _, err := client.Do(ctx, "HDEL", store.stagingSourceKey(incomplete, "runs"),
		rowID(model.Row{"id": "missing"}, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishDataset(ctx, incomplete, "incomplete", time.Now(), map[string]int{"runs": 1}); err == nil {
		t.Fatal("incomplete staging source was published")
	}
	if err := store.DiscardDataset(ctx, incomplete); err != nil {
		t.Fatal(err)
	}
	loaded, _, err = store.ReadSource(ctx, "runs", nil)
	if err != nil || len(loaded.Rows) != 1 || loaded.Rows[0]["id"] != "new" {
		t.Fatalf("failed publication replaced live data: %+v (%v)", loaded.Rows, err)
	}
	expired, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stage(expired, "orphan")
	if _, err := client.Do(ctx, "UNLINK", store.stagingKey(expired)); err != nil {
		t.Fatal(err)
	}
	if err := store.StageDiagnostics(ctx, expired, model.Diagnostics{}); err == nil {
		t.Fatal("expired stage was recreated without a TTL")
	}
	if ttl, err := client.Do(ctx, "TTL", store.stagingSourceKey(expired, "runs")); err != nil || toInt64(ttl) <= 0 {
		t.Fatalf("orphan staging rows lost expiration: %v (%v)", ttl, err)
	}
}

func TestSearchIndexOnlyServesCurrentDataset(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}

	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "search-lifecycle-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	definition := query.Definition{Name: "failures", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "failure"}}}}
	aggregate := query.Definition{Name: "by-conclusion", From: "runs",
		Aggregate: &query.Aggregate{By: []string{"conclusion"},
			Values: []query.AggregateValue{{Field: "conclusion", As: "runs", Reducer: "count"}}}}
	store.ConfigureIndexDefinitions([]query.Definition{definition, aggregate})
	ctx := t.Context()
	publish := func(id, conclusion string) int64 {
		t.Helper()
		token, err := store.BeginDataset(ctx)
		if err != nil {
			t.Fatal(err)
		}
		source := model.Source{Source: "runs", Metadata: model.Metadata{"source-id": "runs"},
			Rows: []model.Row{{"id": id, "conclusion": conclusion}}}
		if err := store.StageSource(ctx, token, source); err != nil {
			t.Fatal(err)
		}
		revision, err := store.PublishDataset(ctx, token, id, time.Now(), map[string]int{"runs": 1})
		if err != nil {
			t.Fatal(err)
		}
		return revision
	}
	first := publish("old", "failure")
	if err := store.RebuildSearchIndexes(ctx, first, map[string]int{"runs": 1}); err != nil {
		t.Fatal(err)
	}
	rows, metrics, err := store.ReadSource(ctx, "runs", &definition)
	if err != nil || len(rows.Rows) != 1 || !containsField(metrics.PushedDown, "indexed-candidates") {
		t.Fatalf("current search index was not used: %+v metrics=%+v err=%v", rows.Rows, metrics, err)
	}
	grouped, aggregateMetrics, err := store.ReadSource(ctx, "runs", &aggregate)
	if err != nil || len(grouped.Rows) != 1 || fmt.Sprint(grouped.Rows[0]["runs"]) != "1" ||
		!containsField(aggregateMetrics.PushedDown, "aggregate") {
		t.Fatalf("native aggregate did not use current index: %+v metrics=%+v err=%v",
			grouped.Rows, aggregateMetrics, err)
	}
	store.Client = interruptIndexedRead{CommandClient: client, datasetKey: store.datasetKey()}
	rows, metrics, err = store.ReadSource(ctx, "runs", &definition)
	if !errors.Is(err, ErrSearchIndexUnavailable) || len(rows.Rows) != 0 {
		t.Fatalf("query used index changed during search: %+v metrics=%+v err=%v", rows.Rows, metrics, err)
	}
	store.Client = rejectIndexCreation{client}
	if err := store.RebuildSearchIndexes(ctx, first, map[string]int{"runs": 1}); err == nil {
		t.Fatal("interrupted indexing unexpectedly succeeded")
	}
	ready, err := store.SearchIndexesReady(ctx, first)
	if err != nil || ready {
		t.Fatalf("interrupted index rebuild remained visible: ready=%v err=%v", ready, err)
	}
	rows, metrics, err = store.ReadSource(ctx, "runs", &definition)
	if !errors.Is(err, ErrSearchIndexUnavailable) || len(rows.Rows) != 0 {
		t.Fatalf("partial index was queried: %+v metrics=%+v err=%v", rows.Rows, metrics, err)
	}
	grouped, _, err = store.ReadSource(ctx, "runs", &aggregate)
	if !errors.Is(err, ErrSearchIndexUnavailable) || len(grouped.Rows) != 0 {
		t.Fatalf("partial aggregate index was queried: %+v err=%v", grouped.Rows, err)
	}
	store.Client = client
	if err := store.RebuildSearchIndexes(ctx, first, map[string]int{"runs": 1}); err != nil {
		t.Fatal(err)
	}
	second := publish("new", "success")
	rows, metrics, err = store.ReadSource(ctx, "runs", &definition)
	if !errors.Is(err, ErrSearchIndexUnavailable) || len(rows.Rows) != 0 {
		t.Fatalf("stale search index supplied candidates: %+v metrics=%+v err=%v", rows.Rows, metrics, err)
	}
	if err := store.RebuildSearchIndexes(ctx, second, map[string]int{"runs": 1}); err != nil {
		t.Fatal(err)
	}
	rows, metrics, err = store.ReadSource(ctx, "runs", &definition)
	if err != nil || len(rows.Rows) != 0 || !containsField(metrics.PushedDown, "indexed-candidates") {
		t.Fatalf("rebuilt search index retained old row: %+v metrics=%+v err=%v", rows.Rows, metrics, err)
	}
	if cardinality, err := client.Do(ctx, "SCARD", store.indexRowsKey("runs")); err != nil || cardinality != int64(1) {
		t.Fatalf("secondary index retained old documents: %v (%v)", cardinality, err)
	}
}

func TestRedisJSONIndexedQueriesAndHashFallback(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "indexed-queries-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	ctx := t.Context()
	aggregate := query.Definition{Name: "duration-summary", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "duration", GTE: 2, LT: 4}}},
		Aggregate: &query.Aggregate{By: []string{"conclusion"}, Values: []query.AggregateValue{
			{Field: "conclusion", As: "runs", Reducer: "count"},
			{Field: "duration", As: "mean-duration", Reducer: "mean"},
		}},
		Select: []query.SelectedField{{Field: "conclusion"}, {Field: "runs"}, {Field: "mean-duration"}},
	}
	grouped := query.Definition{Name: "grouped", From: "runs",
		Aggregate: &query.Aggregate{By: []string{"conclusion"}, Values: []query.AggregateValue{
			{Field: "conclusion", As: "runs", Reducer: "count"},
			{Field: "duration", As: "mean-duration", Reducer: "mean"},
		}}}
	store.ConfigureIndexDefinitions([]query.Definition{aggregate, grouped})
	token, err := store.BeginDataset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	source := model.Source{Source: "runs", Rows: []model.Row{
		{"id": "1", "conclusion": "success", "duration": 1.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
		{"id": "2", "conclusion": "failure", "duration": 2.0, "workflow-role": "orchestrator", "repositoryFullName": "owner/repo-b"},
		{"id": "3", "conclusion": "failure", "duration": 3.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
		{"id": 4, "conclusion": "success", "duration": 4.0, "workflow-role": "worker", "repositoryFullName": "owner/repo-a"},
	}}
	if err := store.StageSource(ctx, token, source); err != nil {
		t.Fatal(err)
	}
	revision, err := store.PublishDataset(ctx, token, "indexed", time.Now(), map[string]int{"runs": 4})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RebuildSearchIndexes(ctx, revision, map[string]int{"runs": 4}); err != nil {
		t.Fatal(err)
	}
	keys, err := client.Do(ctx, "SMEMBERS", store.indexRowsKey("runs"))
	if err != nil {
		t.Fatal(err)
	}
	documents, err := Strings(keys)
	if err != nil || len(documents) != 4 {
		t.Fatalf("expected four indexed documents: %v %v", documents, err)
	}
	for _, key := range documents {
		kind, err := client.Do(ctx, "TYPE", key)
		if err != nil || kind != "ReJSON-RL" {
			t.Fatalf("derived row is not RedisJSON: %v %v", kind, err)
		}
	}
	failure := query.Definition{Name: "failures", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{
			{Field: "conclusion", In: []any{"failure"}}, {Field: "workflow-role", Equals: "worker"},
		}}}
	candidates, metrics, err := store.ReadSource(ctx, "runs", &failure)
	if err != nil || len(candidates.Rows) != 2 || !containsField(metrics.PushedDown, "indexed-candidates") {
		t.Fatalf("indexed candidate selection failed: %+v %+v %v", candidates.Rows, metrics, err)
	}
	filtered, _, _, err := query.ExecuteDefinition(failure,
		map[string]model.Source{"runs": candidates}, query.MaxOperations)
	if err != nil || len(filtered.Rows) != 1 || filtered.Rows[0]["id"] != "3" {
		t.Fatalf("residual filter changed results: %+v %v", filtered.Rows, err)
	}
	for _, tc := range []struct {
		field, value string
		count        int
	}{
		{"workflow-role", "worker", 3}, {"repositoryFullName", "owner/repo-a", 3},
	} {
		definition := query.Definition{Name: "tags", From: "runs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: tc.field, Equals: tc.value}}}}
		rows, metrics, err := store.ReadSource(ctx, "runs", &definition)
		if err != nil || len(rows.Rows) != tc.count || !containsField(metrics.PushedDown, "indexed-candidates") {
			t.Fatalf("%s tag was not indexed: %+v %+v %v", tc.field, rows.Rows, metrics, err)
		}
	}
	unsafe := query.Definition{Name: "unsafe", From: "runs",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "unknown"}}}}
	rows, metrics, err := store.ReadSource(ctx, "runs", &unsafe)
	if err != nil || len(rows.Rows) != 4 || containsField(metrics.PushedDown, "indexed-candidates") {
		t.Fatalf("unsafe indexed predicate did not fall back: %+v %+v %v", rows.Rows, metrics, err)
	}
	groupedRows, metrics, err := store.ReadSource(ctx, "runs", &grouped)
	if err != nil || len(groupedRows.Rows) != 2 || !containsField(metrics.PushedDown, "aggregate") {
		t.Fatalf("native grouping failed: %+v %+v %v", groupedRows.Rows, metrics, err)
	}
	result, _, err := store.ExecutePlan(ctx, []query.Definition{aggregate},
		[]string{aggregate.Name}, []string{"runs", aggregate.Name}, nil)
	if err != nil || len(result[aggregate.Name].Rows) != 1 ||
		result[aggregate.Name].Rows[0]["mean-duration"] != 2.5 {
		t.Fatalf("native filtered aggregate failed: %+v %v", result, err)
	}
	count := query.Definition{Name: "table-count", From: "runs",
		Compute: []query.ComputedField{{As: "table", Function: "literal",
			Args: []query.Argument{{Value: "runs"}}}},
		Aggregate: &query.Aggregate{By: []string{"table"},
			Values: []query.AggregateValue{{Field: "table", As: "records", Reducer: "count"}}}}
	rows, metrics, err = store.ReadSource(ctx, "runs", &count)
	if err != nil || len(rows.Rows) != 1 || rows.Rows[0]["records"] != 4 ||
		metrics.RedisRows != 0 {
		t.Fatalf("native hash count failed: %+v %+v %v", rows.Rows, metrics, err)
	}
}
