package redisx

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type projectedRowsClient struct {
	raw     string
	count   int
	maxPage int
	bounded bool
}

func (client *projectedRowsClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "HGET":
		if command[2] == "revision" {
			return "1", nil
		}
		return `{"availability":"available"}`, nil
	case "HMGET":
		return []any{nil, nil, nil}, nil
	case "EVAL":
		client.bounded = strings.Contains(command[1], "source batch exceeds max working bytes")
		start, err := strconv.Atoi(command[4])
		if err != nil {
			return nil, err
		}
		end := min(start+32, client.count)
		client.maxPage = max(client.maxPage, end-start)
		values := []any{"_staged", "1"}
		for i := start; i < end; i++ {
			values = append(values, fmt.Sprintf("row-%04d", i), client.raw)
		}
		cursor := strconv.Itoa(end)
		if end == client.count {
			cursor = "0"
		}
		return []any{cursor, values}, nil
	}
	return nil, fmt.Errorf("unexpected command %q", command[0])
}

func (*projectedRowsClient) DoMany(context.Context, [][]string) ([]any, error) { return nil, nil }

func TestCountAggregateProjectsAndBoundsLargeSourceRows(t *testing.T) {
	event := model.Row{
		"organization": "example", "repository": "repo", "workflow": "worker",
		"run": "1", "run-attempt": "1", "event": "created",
		"payload": strings.Repeat("x", 1<<20),
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	client := &projectedRowsClient{raw: string(raw), count: 260}
	store := NewStore(client, "projection-test")
	definition := query.Definition{Name: "tool-event-runs", From: "tools",
		Aggregate: &query.Aggregate{
			By:     []string{"organization", "repository", "workflow", "run", "run-attempt"},
			Values: []query.AggregateValue{{Field: "event", As: "events", Reducer: "count"}},
		}}
	source, metrics, err := store.ReadSource(t.Context(), "tools", &definition)
	if err != nil || len(source.Rows) != 260 {
		t.Fatalf("count source failed: rows=%d metrics=%+v error=%v", len(source.Rows), metrics, err)
	}
	if _, ok := source.Rows[0]["payload"]; ok {
		t.Fatal("unneeded large payload was retained")
	}
	result, _, _, err := query.ExecuteDefinition(definition,
		map[string]model.Source{"tools": source}, query.MaxOperations)
	if err != nil || len(result.Rows) != 1 || result.Rows[0]["events"] != 260 {
		t.Fatalf("projected count changed results: %+v %v", result.Rows, err)
	}
	if !client.bounded || client.maxPage > 32 {
		t.Fatalf("unbounded hash scan: page=%d scriptBound=%v", client.maxPage, client.bounded)
	}
}

type marketplaceStoreCommandClient struct {
	command  []string
	getValue any
}

func (client *marketplaceStoreCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string(nil), command...)
	if command[0] == "GET" {
		return client.getValue, nil
	}
	return "OK", nil
}

func (*marketplaceStoreCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestIndexedPredicateRequiresSafeStringEquality(t *testing.T) {
	rows := []model.Row{
		{"conclusion": "success", "state": "open", "mode": true},
		{"conclusion": "failure", "state": nil, "mode": "true"},
	}
	fields := indexedStringFields(rows)
	if !reflect.DeepEqual(fields, []string{"conclusion", "state"}) {
		t.Fatalf("unexpected indexed fields: %v", fields)
	}
	for _, test := range []struct {
		name   string
		filter query.Filter
		want   string
	}{
		{"equality", query.Filter{Predicates: []query.Predicate{{Field: "conclusion", Equals: "failure"}}}, "@conclusion:{failure}"},
		{"alternatives", query.Filter{Predicates: []query.Predicate{{Field: "conclusion", In: []any{"success", "failure"}}}}, "@conclusion:{success|failure}"},
		{"escaped coordinate", query.Filter{Predicates: []query.Predicate{{Field: "state", Equals: "owner/repo-name"}}}, `@state:{owner\/repo\-name}`},
		{"unindexed", query.Filter{Predicates: []query.Predicate{{Field: "mode", Equals: "true"}}}, ""},
		{"missing unknown", query.Filter{Predicates: []query.Predicate{{Field: "state", Equals: "unknown"}}}, ""},
		{"optional", query.Filter{Predicates: []query.Predicate{{Field: "state", Equals: "open", Optional: true}}}, ""},
		{"injection", query.Filter{Predicates: []query.Predicate{{Field: "state", Equals: "open|*"}}}, ""},
		{"mixed types", query.Filter{Predicates: []query.Predicate{{Field: "state", In: []any{"open", true}}}}, ""},
		{"substring", query.Filter{Predicates: []query.Predicate{{Field: "state", Includes: "pen"}}}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := indexedPredicate(&test.filter, fields); got != test.want {
				t.Fatalf("expression = %q, want %q", got, test.want)
			}
		})
	}
}

func TestProcessIsolatedStoresUseFreshNamespaces(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	first, err := NewProcessIsolatedStore(client, "cao:hosted-dashboard")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewProcessIsolatedStore(client, "hosted-dashboard")
	if err != nil {
		t.Fatal(err)
	}
	if !first.ProcessIsolated() || !second.ProcessIsolated() {
		t.Fatal("process-isolated store did not report its capability")
	}
	if first.Key("") == second.Key("") {
		t.Fatal("process-isolated stores shared a namespace")
	}
}

func TestCacheMarketplaceRegistrySetsNamespacedKeyAndMillisecondTTL(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "marketplace-test")

	if err := store.CacheMarketplaceRegistry(t.Context(), "official", "dataset-1", []byte(`{"packages":[]}`), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if len(client.command) != 5 || client.command[0] != "SET" {
		t.Fatalf("unexpected Redis command: %#v", client.command)
	}
	if client.command[1] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "dataset-1")) {
		t.Fatalf("unexpected cache key: %s", client.command[1])
	}
	if client.command[2] != `{"packages":[]}` {
		t.Fatalf("unexpected cached payload: %s", client.command[2])
	}
	if client.command[3] != "PX" || client.command[4] != "90000" {
		t.Fatalf("unexpected TTL arguments: %#v", client.command[3:])
	}
}

func TestCacheMarketplaceRegistrySkipsWriteForNonPositiveTTL(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "marketplace-test")

	if err := store.CacheMarketplaceRegistry(t.Context(), "official", "dataset-1", []byte("{}"), 0); err != nil {
		t.Fatal(err)
	}
	if client.command != nil {
		t.Fatalf("expected no Redis command for a non-positive TTL, got: %#v", client.command)
	}
}

func TestCacheRepositoryMemoryUsesNamespacedKeysAndTTL(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "memory-test")
	ttl := 5 * time.Minute

	if err := store.CacheRepositoryMemoryCampaign(
		t.Context(), "campaign", []byte(`{"campaign":"campaign"}`), ttl,
	); err != nil {
		t.Fatal(err)
	}
	assertRepositoryMemoryCacheCommand(t, client.command,
		store.Key("repository-memory:campaign:"+repositoryMemoryCacheKey("campaign")), ttl)

	if err := store.CacheRepositoryMemoryFile(
		t.Context(), "campaign", "commit", "notes.md", []byte("content"), time.Hour,
	); err != nil {
		t.Fatal(err)
	}
	assertRepositoryMemoryCacheCommand(t, client.command,
		store.Key("repository-memory:cached-file:"+repositoryMemoryCacheKey("campaign", "commit", "notes.md")), time.Hour)
}

func assertRepositoryMemoryCacheCommand(t *testing.T, command []string, key string, ttl time.Duration) {
	t.Helper()
	if len(command) != 5 || command[0] != "SET" || command[1] != key {
		t.Fatalf("unexpected Redis cache command: %#v", command)
	}
	if command[3] != "PX" || command[4] != strconv.FormatInt(ttl.Milliseconds(), 10) {
		t.Fatalf("unexpected Redis cache TTL arguments: %#v", command[3:])
	}
}

func TestCachedMarketplaceRegistryReturnsNilOnMiss(t *testing.T) {
	client := &marketplaceStoreCommandClient{getValue: nil}
	store := NewStore(client, "marketplace-test")

	data, err := store.CachedMarketplaceRegistry(t.Context(), "official", "dataset-1")
	if err != nil {
		t.Fatal(err)
	}
	if data != nil {
		t.Fatalf("expected a cache miss to return nil, got: %s", data)
	}
}

func TestCachedMarketplaceRegistryReturnsStoredPayloadOnHit(t *testing.T) {
	client := &marketplaceStoreCommandClient{getValue: `{"packages":[{"id":"official:example/packages@main"}]}`}
	store := NewStore(client, "marketplace-test")

	data, err := store.CachedMarketplaceRegistry(t.Context(), "official", "dataset-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != client.getValue {
		t.Fatalf("unexpected cached payload: %s", data)
	}
	if client.command[1] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "dataset-1")) {
		t.Fatalf("unexpected GET key: %s", client.command[1])
	}
}

func TestMarketplaceCacheKeyIsolatesByRegistryAndDataRevision(t *testing.T) {
	base := marketplaceCacheKey("official", "revision-1")
	if marketplaceCacheKey("third-party", "revision-1") == base {
		t.Fatal("different registries produced the same cache key")
	}
	if marketplaceCacheKey("official", "revision-2") == base {
		t.Fatal("different data revisions produced the same cache key")
	}
	if marketplaceCacheKey("official", "revision-1") != base {
		t.Fatal("identical inputs produced different cache keys")
	}
}

func TestParseActiveDatasetDecodesAllFields(t *testing.T) {
	evaluatedAt := "2024-05-01T12:00:00Z"
	activatedAt := "2024-05-01T12:00:05Z"
	fields := []string{
		"revision", "7",
		"dataRevision", "rev-abc",
		"evaluatedAt", evaluatedAt,
		"counts", `{"events":3}`,
		"activatedAt", activatedAt,
	}
	result, malformed := parseActiveDataset(fields)
	if malformed != 0 {
		t.Fatalf("expected no malformed fields, got %d", malformed)
	}
	if result.Revision != 7 || result.DataRevision != "rev-abc" {
		t.Fatalf("unexpected scalar fields: %+v", result)
	}
	if result.Counts["events"] != 3 {
		t.Fatalf("unexpected counts: %+v", result.Counts)
	}
	if !result.EvaluatedAt.Equal(mustParseRFC3339Nano(t, evaluatedAt)) {
		t.Fatalf("unexpected evaluatedAt: %v", result.EvaluatedAt)
	}
	if !result.Activated.Equal(mustParseRFC3339Nano(t, activatedAt)) {
		t.Fatalf("unexpected activatedAt: %v", result.Activated)
	}
}

func TestParseActiveDatasetCountsMalformedFieldsAndKeepsValidOnes(t *testing.T) {
	fields := []string{
		"revision", "not-a-number",
		"evaluatedAt", "not-a-time",
		"counts", "not-json",
		"activatedAt", "also-not-a-time",
	}
	result, malformed := parseActiveDataset(fields)
	if malformed != 4 {
		t.Fatalf("expected 4 malformed fields, got %d", malformed)
	}
	if result.Revision != 0 || !result.EvaluatedAt.IsZero() || !result.Activated.IsZero() {
		t.Fatalf("expected zero values for malformed fields, got %+v", result)
	}
	if len(result.Counts) != 0 {
		t.Fatalf("expected empty counts for malformed JSON, got %+v", result.Counts)
	}
}

func TestParseActiveDatasetHandlesEmptyAndOddLengthInput(t *testing.T) {
	if result, malformed := parseActiveDataset(nil); malformed != 0 || result.Revision != 0 {
		t.Fatalf("expected zero-value result for nil input, got %+v malformed=%d", result, malformed)
	}
	if result, malformed := parseActiveDataset([]string{"revision"}); malformed != 0 || result.Revision != 0 {
		t.Fatalf("expected trailing unpaired field to be ignored, got %+v malformed=%d", result, malformed)
	}
}

func mustParseRFC3339Nano(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse test timestamp %q: %v", value, err)
	}
	return parsed
}
