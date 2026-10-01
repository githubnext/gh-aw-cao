package redisx

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type sourceRowsClient struct {
	rows     []any
	maxBatch int
	bounded  bool
}

func (client *sourceRowsClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "HGET":
		return `{"availability":"available"}`, nil
	case "SMEMBERS":
		keys := make([]any, len(client.rows))
		for i := range keys {
			keys[i] = strconv.Itoa(i)
		}
		return keys, nil
	case "EVAL":
		client.maxBatch = max(client.maxBatch, len(command)-3)
		client.bounded = client.bounded || strings.Contains(command[1], "source batch exceeds max working bytes")
		rows := make([]any, 0, len(command)-3)
		for _, key := range command[3:] {
			index, err := strconv.Atoi(key)
			if err != nil {
				return nil, err
			}
			rows = append(rows, client.rows[index])
		}
		return rows, nil
	default:
		panic("unexpected Redis command")
	}
}

func (*sourceRowsClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

type storeQueryLoader struct {
	store *Store
	ctx   context.Context
}

func (loader storeQueryLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return loader.store.LoadSource(loader.ctx, "generation", name, definition)
}

func TestCountAggregateProjectsLargeToolRows(t *testing.T) {
	event := map[string]any{
		"organization": "example", "repository": "repo", "workflow": "worker",
		"run": "1", "run-attempt": "1", "event": "created",
		"payload": "unrelated tool details",
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	client := &sourceRowsClient{rows: []any{string(raw), string(raw)}}
	store := NewStore(client, "count-test")
	definition := query.Definition{
		Name: "tool-event-runs", From: "tools",
		Aggregate: &query.Aggregate{
			By:     []string{"organization", "repository", "workflow", "run", "run-attempt"},
			Values: []query.AggregateValue{{Field: "event", As: "events", Reducer: "count"}},
		},
	}
	source, _, err := store.LoadSource(t.Context(), "generation", "tools", &definition)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := source.Rows[0]["payload"]; ok {
		t.Fatal("unneeded tool payload was retained")
	}
	result, _, err := query.New(storeQueryLoader{store, t.Context()}).Execute([]query.Definition{definition}, []string{definition.Name})
	if err != nil {
		t.Fatal(err)
	}
	want := []model.Row{{"organization": "example", "repository": "repo", "workflow": "worker",
		"run": "1", "run-attempt": "1", "events": 2}}
	if !reflect.DeepEqual(result[definition.Name].Rows, want) {
		t.Fatalf("unexpected count rows: %#v", result[definition.Name].Rows)
	}

	withFilter := definition
	withFilter.Filter = &query.Filter{Predicates: []query.Predicate{{Field: "payload", Equals: "unrelated tool details"}}}
	source, _, err = store.LoadSource(t.Context(), "generation", "tools", &withFilter)
	if err != nil {
		t.Fatal(err)
	}
	if source.Rows[0]["payload"] != event["payload"] {
		t.Fatal("filtered query lost a required field")
	}
}

func TestCountAggregateStaysUnderWorkingByteLimit(t *testing.T) {
	event := map[string]any{
		"organization": "example", "repository": "repo", "workflow": "worker",
		"run": "1", "run-attempt": "1", "event": "created",
		"payload": strings.Repeat("x", 1<<20),
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	client := &sourceRowsClient{rows: make([]any, 260)}
	for i := range client.rows {
		client.rows[i] = string(raw)
	}
	store := NewStore(client, "count-limit-test")
	definition := query.Definition{
		Name: "tool-event-runs", From: "tools",
		Aggregate: &query.Aggregate{
			By:     []string{"organization", "repository", "workflow", "run", "run-attempt"},
			Values: []query.AggregateValue{{Field: "event", As: "events", Reducer: "count"}},
		},
	}
	result, metrics, err := query.New(storeQueryLoader{store, t.Context()}).Execute(
		[]query.Definition{definition}, []string{definition.Name})
	if err != nil {
		t.Fatal(err)
	}
	if len(result[definition.Name].Rows) != 1 || result[definition.Name].Rows[0]["events"] != 260 {
		t.Fatalf("unexpected count: %#v", result[definition.Name].Rows)
	}
	if metrics.PeakWorkingBytes >= query.MaxWorkingBytes {
		t.Fatalf("unneeded payload was included in working bytes: %d", metrics.PeakWorkingBytes)
	}
	if client.maxBatch > 32 || !client.bounded {
		t.Fatalf("projected source fetched an unbounded raw batch: max=%d bounded=%v", client.maxBatch, client.bounded)
	}
}

// marketplaceStoreCommandClient is a minimal fake CommandClient, mirroring the
// fake used in rate_limit_test.go, that records the last command issued and
// serves a fixed GET response so CacheMarketplaceRegistry/
// CachedMarketplaceRegistry can be exercised without a real Redis server.
type marketplaceStoreCommandClient struct {
	getValue any
	command  []string
}

func (client *marketplaceStoreCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	if command[0] == "GET" {
		return client.getValue, nil
	}
	return "OK", nil
}

func (*marketplaceStoreCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
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

	if err := store.CacheMarketplaceRegistry(t.Context(), "official", "generation-1", []byte(`{"packages":[]}`), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if len(client.command) != 5 || client.command[0] != "SET" {
		t.Fatalf("unexpected Redis command: %#v", client.command)
	}
	if client.command[1] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "generation-1")) {
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

	if err := store.CacheMarketplaceRegistry(t.Context(), "official", "generation-1", []byte("{}"), 0); err != nil {
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

	data, err := store.CachedMarketplaceRegistry(t.Context(), "official", "generation-1")
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

	data, err := store.CachedMarketplaceRegistry(t.Context(), "official", "generation-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != client.getValue {
		t.Fatalf("unexpected cached payload: %s", data)
	}
	if client.command[1] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "generation-1")) {
		t.Fatalf("unexpected GET key: %s", client.command[1])
	}
}

func TestMarketplaceCacheKeyIsolatesByRegistryAndGeneration(t *testing.T) {
	base := marketplaceCacheKey("official", "generation-1")
	if marketplaceCacheKey("third-party", "generation-1") == base {
		t.Fatal("different registries produced the same cache key")
	}
	if marketplaceCacheKey("official", "generation-2") == base {
		t.Fatal("different generations produced the same cache key")
	}
	if marketplaceCacheKey("official", "generation-1") != base {
		t.Fatal("identical inputs produced different cache keys")
	}
}

func TestParseActiveGenerationDecodesAllFields(t *testing.T) {
	evaluatedAt := "2024-05-01T12:00:00Z"
	activatedAt := "2024-05-01T12:00:05Z"
	fields := []string{
		"generation", "gen-1",
		"revision", "7",
		"dataRevision", "rev-abc",
		"evaluatedAt", evaluatedAt,
		"counts", `{"events":3}`,
		"activatedAt", activatedAt,
	}
	result, malformed := parseActiveGeneration(fields)
	if malformed != 0 {
		t.Fatalf("expected no malformed fields, got %d", malformed)
	}
	if result.Generation != "gen-1" || result.Revision != 7 || result.DataRevision != "rev-abc" {
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

func TestParseActiveGenerationCountsMalformedFieldsAndKeepsValidOnes(t *testing.T) {
	fields := []string{
		"generation", "gen-2",
		"revision", "not-a-number",
		"evaluatedAt", "not-a-time",
		"counts", "not-json",
		"activatedAt", "also-not-a-time",
	}
	result, malformed := parseActiveGeneration(fields)
	if malformed != 4 {
		t.Fatalf("expected 4 malformed fields, got %d", malformed)
	}
	if result.Generation != "gen-2" {
		t.Fatalf("unexpected generation: %q", result.Generation)
	}
	if result.Revision != 0 || !result.EvaluatedAt.IsZero() || !result.Activated.IsZero() {
		t.Fatalf("expected zero values for malformed fields, got %+v", result)
	}
	if len(result.Counts) != 0 {
		t.Fatalf("expected empty counts for malformed JSON, got %+v", result.Counts)
	}
}

func TestParseActiveGenerationHandlesEmptyAndOddLengthInput(t *testing.T) {
	if result, malformed := parseActiveGeneration(nil); malformed != 0 || result.Generation != "" {
		t.Fatalf("expected zero-value result for nil input, got %+v malformed=%d", result, malformed)
	}
	if result, malformed := parseActiveGeneration([]string{"generation"}); malformed != 0 || result.Generation != "" {
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
