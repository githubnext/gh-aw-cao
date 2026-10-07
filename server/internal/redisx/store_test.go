package redisx

import (
	"context"
	"strconv"
	"testing"
	"time"
)

type marketplaceStoreCommandClient struct {
	getValue any
	command  []string
}

func (client *marketplaceStoreCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	if command[0] == "INFO" {
		return testMemoryInfo, nil
	}
	if command[0] == "EVAL" {
		if command[1] == cacheCapabilityScript {
			return testCacheCapabilityReply(), nil
		}
		if command[1] == cachedValueScript {
			return client.getValue, nil
		}
		return int64(1), nil
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
	services := first.OperationalServices()
	if services.Queue != nil || services.Admission != nil || services.Collection != nil {
		t.Fatal("process-isolated store exposed collection services")
	}
	if services.Sessions != first || services.Revocations != first || services.Backend != first {
		t.Fatal("process-isolated services did not share the owning store")
	}
}

func TestCacheMarketplaceRegistrySetsNamespacedKeyAndMillisecondTTL(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "marketplace-test")

	if err := store.CacheMarketplaceRegistry(t.Context(), "official", "generation-1", []byte(`{"packages":[]}`), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if len(client.command) != 7 || client.command[0] != "EVAL" {
		t.Fatalf("unexpected Redis command: %#v", client.command)
	}
	if client.command[3] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "generation-1")) {
		t.Fatalf("unexpected cache key: %s", client.command[3])
	}
	if client.command[4] != `{"packages":[]}` {
		t.Fatalf("unexpected cached payload: %s", client.command[4])
	}
	if client.command[5] != "90000" || client.command[6] != "200000000" {
		t.Fatalf("unexpected TTL and budget arguments: %#v", client.command[5:])
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
	if len(command) != 7 || command[0] != "EVAL" || command[3] != key {
		t.Fatalf("unexpected Redis cache command: %#v", command)
	}
	if command[5] != strconv.FormatInt(ttl.Milliseconds(), 10) || command[6] != "200000000" {
		t.Fatalf("unexpected Redis cache TTL and budget arguments: %#v", command[5:])
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
	if client.command[0] != "EVAL" || client.command[3] != store.Key("marketplace:registry:"+marketplaceCacheKey("official", "generation-1")) {
		t.Fatalf("unexpected bounded read: %v", client.command)
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
