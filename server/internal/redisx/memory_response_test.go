package redisx

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type enterpriseMemoryClient struct {
	CommandClient
	infoUnsupported   bool
	memoryUnsupported bool
	quotaUnknown      bool
	probes            int
	deleted           []string
}

func (client *enterpriseMemoryClient) Do(ctx context.Context, command ...string) (any, error) {
	if len(command) == 0 || (command[0] == "EVAL" && len(command) < 4) {
		return nil, errors.New("invalid validation command")
	}
	if command[0] == "INFO" && client.quotaUnknown {
		value, err := client.CommandClient.Do(ctx, command...)
		if err != nil {
			return nil, err
		}
		var lines []string
		for _, line := range strings.Split(value.(string), "\r\n") {
			if !strings.HasPrefix(line, "maxmemory:") {
				lines = append(lines, line)
			}
		}
		return strings.Join(lines, "\r\n"), nil
	}
	if command[0] == "EVAL" && command[1] == cacheCapabilityScript {
		if len(command) < 4 {
			return nil, errors.New("invalid capability validation command")
		}
		key := command[3]
		client.probes++
		var info, memory []any
		if client.infoUnsupported {
			info = []any{int64(0), "ERR command is not allowed in scripts"}
		} else {
			value, err := client.Do(ctx, "INFO", "memory")
			if err != nil {
				return nil, err
			}
			info = []any{int64(1), value}
		}
		if client.memoryUnsupported {
			memory = []any{int64(0), "ERR command is not allowed in scripts"}
		} else {
			value, err := client.CommandClient.Do(ctx, "MEMORY", "USAGE", key, "SAMPLES", "0")
			if err != nil {
				return nil, err
			}
			memory = []any{int64(1), value}
		}
		return []any{info, memory}, nil
	}
	if command[0] == "EVAL" && (strings.Contains(command[1], `redis.call("INFO"`) ||
		strings.Contains(command[1], `redis.call("MEMORY"`)) {
		return nil, errors.New("unsupported script introspection reached Redis")
	}
	if command[0] == "DEL" {
		client.deleted = append(client.deleted, command[1:]...)
	}
	return client.CommandClient.Do(ctx, command...)
}

func TestManagedProviderFallbackAgainstRedis(t *testing.T) {
	for _, unsupported := range []string{"INFO", "MEMORY", "both", "Azure-no-quota", "script-no-quota"} {
		t.Run(unsupported, func(t *testing.T) {
			original := memoryIntegrationStore(t)
			fillDisposableCaches(t, original)
			before, err := original.sampleMemory(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			client := &enterpriseMemoryClient{
				CommandClient:     original.Client,
				infoUnsupported:   unsupported == "INFO" || unsupported == "both" || unsupported == "Azure-no-quota",
				memoryUnsupported: unsupported == "MEMORY" || unsupported == "both",
				quotaUnknown:      unsupported == "Azure-no-quota" || unsupported == "script-no-quota",
			}
			store := NewStore(client, original.namespace)
			if err := store.SetMaxMemoryBytes(before.UsedBytes - 200<<10); err != nil {
				t.Fatal(err)
			}
			for _, read := range []func() ([]byte, error){
				func() ([]byte, error) { return store.CachedMarketplaceRegistry(t.Context(), "registry", "revision") },
				func() ([]byte, error) { return store.CachedRepositoryMemoryCampaign(t.Context(), "campaign") },
				func() ([]byte, error) {
					return store.CachedRepositoryMemoryFile(t.Context(), "campaign", "commit", "file")
				},
				func() ([]byte, error) {
					value, _, err := store.CachedQueryResult(t.Context(), queryDigest("query"), 1<<20, 64<<20)
					return value, err
				},
			} {
				if value, err := read(); err != nil || value != nil {
					t.Fatalf("disabled cache served a pre-existing result: bytes=%d err=%v", len(value), err)
				}
			}
			if err := store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", []byte("replacement"), time.Minute); err != nil {
				t.Fatal(err)
			}
			if stored, _, err := store.CacheQueryResult(t.Context(), queryDigest("new"), []byte("value"), 1024, 4096); err != nil || stored {
				t.Fatalf("disabled query admission: stored=%t err=%v", stored, err)
			}
			stats, err := store.MaintainCaches(t.Context(), 64<<20)
			if err != nil || stats.UsedBytes > stats.BudgetBytes || client.probes != 1 || store.DisposableCachesEnabled() {
				t.Fatalf("managed maintenance: stats=%+v probes=%d enabled=%t err=%v", stats, client.probes, store.DisposableCachesEnabled(), err)
			}
			if client.quotaUnknown && stats.BudgetBytes != store.MaxMemoryBytes() {
				t.Fatalf("unknown quota did not retain configured budget: stats=%+v maximum=%d", stats, store.MaxMemoryBytes())
			}
			for _, key := range client.deleted {
				if !store.disposableKey(key) {
					t.Fatalf("managed fallback deleted a protected key: %s", key)
				}
			}
			for _, key := range store.queryCacheKeys() {
				if value, err := original.Client.Do(t.Context(), "EXISTS", key); err != nil || value != int64(0) {
					t.Fatalf("disabled query container remains: value=%v err=%v", value, err)
				}
			}
		})
	}
}

func TestDisposableCacheReadsReserveGlobalOutgoingHeadroomAgainstRedis(t *testing.T) {
	payload := []byte(strings.Repeat("x", 1<<20))
	for _, kind := range []string{"query", "marketplace", "campaign", "file"} {
		t.Run(kind, func(t *testing.T) {
			store := memoryIntegrationStore(t)
			var err error
			switch kind {
			case "query":
				stored, _, putErr := store.CacheQueryResult(t.Context(), queryDigest("response"), payload, 1<<20, 64<<20)
				err = putErr
				if !stored {
					t.Fatalf("response fixture was not admitted: %v", err)
				}
			case "marketplace":
				err = store.CacheMarketplaceRegistry(t.Context(), "registry", "revision", payload, time.Minute)
			case "campaign":
				err = store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", payload, time.Minute)
			case "file":
				err = store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", payload, time.Minute)
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := store.sampleMemory(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SetMaxMemoryBytes(before.UsedBytes + int64(len(payload))); err != nil {
				t.Fatal(err)
			}
			var value []byte
			switch kind {
			case "query":
				value, _, err = store.CachedQueryResult(t.Context(), queryDigest("response"), 1<<20, 64<<20)
			case "marketplace":
				value, err = store.CachedMarketplaceRegistry(t.Context(), "registry", "revision")
			case "campaign":
				value, err = store.CachedRepositoryMemoryCampaign(t.Context(), "campaign")
			case "file":
				value, err = store.CachedRepositoryMemoryFile(t.Context(), "campaign", "commit", "file")
			}
			if err != nil || value != nil {
				t.Fatalf("unsafe response served: bytes=%d err=%v", len(value), err)
			}
			after, err := store.sampleMemory(t.Context())
			if err != nil || after.UsedBytes > after.BudgetBytes {
				t.Fatalf("response allocation exceeded target: %+v err=%v", after, err)
			}
		})
	}
}

func TestQueryOutgoingReserveDoesNotConsumeStoredBudgetOrRenewTTLAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	payload := []byte(strings.Repeat("x", 1<<20))
	key := queryDigest("response")
	if stored, _, err := store.CacheQueryResult(t.Context(), key, payload, 1<<20, 2<<20); err != nil || !stored {
		t.Fatalf("admission: stored=%t err=%v", stored, err)
	}
	deadline, err := store.Client.Do(t.Context(), "ZSCORE", keys[1], key)
	if err != nil {
		t.Fatal(err)
	}
	localBudget := cacheMemory(t, store, keys) + 1024
	value, stats, err := store.CachedQueryResult(t.Context(), key, 1<<20, localBudget)
	if err != nil || len(value) != len(payload) || stats.Evicted != 0 {
		t.Fatalf("outgoing reserve was charged to stored cache: bytes=%d stats=%+v err=%v", len(value), stats, err)
	}
	if stored, _, err := store.CacheQueryResult(t.Context(), key, []byte("replacement"), 1<<20, localBudget); err != nil || !stored {
		t.Fatalf("duplicate admission: stored=%t err=%v", stored, err)
	}
	value, _, err = store.CachedQueryResult(t.Context(), key, 1<<20, localBudget)
	after, scoreErr := store.Client.Do(t.Context(), "ZSCORE", keys[1], key)
	if err != nil || len(value) != len(payload) || scoreErr != nil || after != deadline {
		t.Fatalf("duplicate/read changed payload or TTL: bytes=%d before=%v after=%v err=%v scoreErr=%v",
			len(value), deadline, after, err, scoreErr)
	}
}

func closeTestIdleRedisConnections(t *testing.T, store *Store) {
	t.Helper()
	client, ok := store.Client.(*Client)
	if !ok {
		t.Fatal("response fixture requires a private native Redis client")
	}
	for {
		select {
		case connection := <-client.pool:
			if err := connection.connection.Close(); err != nil {
				t.Fatal(err)
			}
		default:
			return
		}
	}
}

func TestQueryCacheResponseHeadroomPreventsProviderOOMAgainstRedis(t *testing.T) {
	store, _ := queryCacheIntegrationStore(t)
	info, err := store.Client.Do(t.Context(), "INFO", "memory")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(info.(string), "\nmaxmemory:20000000\r\n") {
		t.Skip("requires the isolated 20,000,000-byte noeviction validation instance")
	}
	key := queryDigest("6MiB")
	payload := []byte(strings.Repeat("x", 6<<20))
	if stored, _, err := store.CacheQueryResult(t.Context(), key, payload, int64(len(payload)), 64<<20); err != nil || !stored {
		t.Fatalf("large admission: stored=%t err=%v", stored, err)
	}
	closeTestIdleRedisConnections(t, store)
	protected := store.Key("session:protected")
	newSession := store.Key("session:new")
	t.Cleanup(func() {
		if _, err := store.Client.Do(context.Background(), "DEL", protected, newSession); err != nil {
			t.Errorf("clean up protected fixture: %v", err)
		}
	})
	if _, err := store.Client.Do(t.Context(), "SET", protected, strings.Repeat("s", 7<<20)); err != nil {
		t.Fatal(err)
	}
	closeTestIdleRedisConnections(t, store)
	before, err := store.sampleMemory(t.Context())
	if err != nil || before.UsedBytes > before.BudgetBytes {
		t.Fatalf("fixture starts over budget: %+v err=%v", before, err)
	}
	value, _, err := store.CachedQueryResult(t.Context(), key, int64(len(payload)), 64<<20)
	if err != nil || value != nil {
		t.Fatalf("OOM-producing response was served: bytes=%d err=%v", len(value), err)
	}
	if _, err := store.Client.Do(t.Context(), "SET", newSession, "still writable"); err != nil {
		t.Fatalf("protected write blocked after cache read: %v", err)
	}
	if length, err := store.Client.Do(t.Context(), "STRLEN", protected); err != nil || length != int64(7<<20) {
		t.Fatalf("protected state changed: length=%v err=%v", length, err)
	}
	after, err := store.sampleMemory(t.Context())
	if err != nil || after.UsedBytes > after.BudgetBytes {
		t.Fatalf("headroom enforcement: %+v err=%v", after, err)
	}
	t.Logf("before=%d after=%d effective=%d", before.UsedBytes, after.UsedBytes, after.BudgetBytes)
}
