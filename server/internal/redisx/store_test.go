package redisx

import (
	"context"
	"testing"
	"time"
)

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
