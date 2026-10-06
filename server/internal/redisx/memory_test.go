package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRedisMemoryBudgetAndReplyValidation(t *testing.T) {
	store := NewStore(queryCacheReplyClient{}, "memory-unit")
	if store.MaxMemoryBytes() != 200_000_000 {
		t.Fatalf("default budget = %d", store.MaxMemoryBytes())
	}
	for _, invalid := range []int64{0, -1} {
		if err := store.SetMaxMemoryBytes(invalid); err == nil {
			t.Fatalf("invalid budget accepted: %d", invalid)
		}
	}
	if err := store.SetMaxMemoryBytes(4096); err != nil || store.MaxMemoryBytes() != 4096 {
		t.Fatalf("explicit budget not applied: %v", err)
	}
	for _, invalid := range []any{
		nil, "invalid", []any{int64(1)},
		"maxmemory:0\r\n", "used_memory:1\r\nmaxmemory:\r\n",
		"used_memory:1\r\nmaxmemory:invalid\r\n",
		"used_memory:-1\r\nmaxmemory:0\r\n",
		"used_memory:1\r\nmaxmemory:-1\r\n",
		"used_memory:1\r\nmaxmemory:1\r\n",
		"used_memory:1\r\nused_memory:2\r\nmaxmemory:0\r\n",
		"used_memory:1\r\nmaxmemory:0\r\nmaxmemory:0\r\n",
		"used_memory:+1\r\nmaxmemory:0\r\n",
		"used_memory:1\r\nmaxmemory:9223372036854775808\r\n",
	} {
		if _, err := store.parseMemoryInfo(invalid); err == nil {
			t.Fatalf("invalid memory statistics accepted: %v", invalid)
		}
	}
	stats, err := store.parseMemoryInfo(testMemoryInfo)
	if err != nil || stats != (MemoryStats{UsedBytes: 1024, BudgetBytes: 4096}) {
		t.Fatalf("statistics = %+v, error = %v", stats, err)
	}
	stats, err = store.parseMemoryInfo("used_memory:1024\r\nmaxmemory:4096\r\n")
	if err != nil || stats.BudgetBytes != 3276 {
		t.Fatalf("provider budget was not enforced: %+v, %v", stats, err)
	}
	for _, test := range []struct {
		info     string
		reported bool
	}{
		{info: "used_memory:5000\r\n"},
		{info: "used_memory:5000\r\nmaxmemory:0\r\n", reported: true},
	} {
		stats, reported, err := store.parseMemoryInfoWithQuota(test.info)
		if err != nil || reported != test.reported || stats.UsedBytes != 5000 || stats.BudgetBytes != 4096 {
			t.Fatalf("unknown/zero quota: stats=%+v reported=%t err=%v", stats, reported, err)
		}
	}
}

func TestUnsupportedScriptIntrospection(t *testing.T) {
	for _, test := range []struct {
		name    string
		message string
		probe   int
		want    bool
	}{
		{name: "command not allowed from script", message: "ERR This Redis command is not allowed from script", probe: 0, want: true},
		{name: "command not allowed in script", message: "ERR This Redis command is not allowed in script", probe: 1, want: true},
		{name: "not supported for scripts", message: "ERR INFO is not supported for scripts", probe: 0, want: true},
		{name: "not supported in lua", message: "ERR MEMORY is not supported in lua", probe: 1, want: true},
		{name: "unknown command info", message: "ERR unknown command 'INFO'", probe: 0, want: true},
		{name: "unknown command memory on info probe mismatches", message: "ERR unknown command 'MEMORY'", probe: 0, want: false},
		{name: "unknown command memory", message: "ERR unknown command 'MEMORY'", probe: 1, want: true},
		{name: "unknown subcommand usage", message: "ERR unknown subcommand or wrong number of arguments for 'USAGE'", probe: 1, want: true},
		{name: "unknown subcommand usage on info probe mismatches", message: "ERR unknown subcommand 'USAGE'", probe: 0, want: false},
		{name: "unrelated error", message: "ERR wrong number of arguments", probe: 0, want: false},
		{name: "mixed case still matches", message: "Err Unknown Command 'info'", probe: 0, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := unsupportedScriptIntrospection(test.message, test.probe); got != test.want {
				t.Fatalf("unsupportedScriptIntrospection(%q, %d) = %t, want %t", test.message, test.probe, got, test.want)
			}
		})
	}
}

func TestClassifyCapabilityProbe(t *testing.T) {
	quotaReported := func(any) (bool, error) { return true, nil }
	quotaAbsent := func(any) (bool, error) { return false, nil }
	quotaFailed := func(any) (bool, error) { return false, errors.New("invalid Redis memory INFO response") }

	t.Run("wrong field count is rejected", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{int64(1)}, quotaReported); err == nil {
			t.Fatal("expected an error for a malformed probe shape")
		}
	})
	t.Run("non-integer status is rejected", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{"1", nil}, quotaReported); err == nil {
			t.Fatal("expected an error for a non-integer status")
		}
	})
	t.Run("unsupported introspection disables caches", func(t *testing.T) {
		forceDisable, err := classifyCapabilityProbe(0, []any{int64(0), "ERR unknown command 'INFO'"}, quotaReported)
		if err != nil || !forceDisable {
			t.Fatalf("forceDisable=%t err=%v, want true, nil", forceDisable, err)
		}
	})
	t.Run("unrecognized script failure is rejected", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{int64(0), "ERR wrong number of arguments"}, quotaReported); err == nil {
			t.Fatal("expected an error for an unrecognized script failure")
		}
	})
	t.Run("non-string failure payload is rejected", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{int64(0), int64(1)}, quotaReported); err == nil {
			t.Fatal("expected an error for a non-string failure payload")
		}
	})
	t.Run("index zero with reported quota stays enabled", func(t *testing.T) {
		forceDisable, err := classifyCapabilityProbe(0, []any{int64(1), "used_memory:1\r\nmaxmemory:0\r\n"}, quotaReported)
		if err != nil || forceDisable {
			t.Fatalf("forceDisable=%t err=%v, want false, nil", forceDisable, err)
		}
	})
	t.Run("index zero without a reported quota disables caches", func(t *testing.T) {
		forceDisable, err := classifyCapabilityProbe(0, []any{int64(1), "used_memory:1\r\n"}, quotaAbsent)
		if err != nil || !forceDisable {
			t.Fatalf("forceDisable=%t err=%v, want true, nil", forceDisable, err)
		}
	})
	t.Run("index zero propagates a quota lookup failure", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{int64(1), "invalid"}, quotaFailed); err == nil {
			t.Fatal("expected the quota lookup error to propagate")
		}
	})
	t.Run("index one accepts a nil usage probe", func(t *testing.T) {
		forceDisable, err := classifyCapabilityProbe(1, []any{int64(1), nil}, quotaReported)
		if err != nil || forceDisable {
			t.Fatalf("forceDisable=%t err=%v, want false, nil", forceDisable, err)
		}
	})
	t.Run("index one accepts a valid usage probe", func(t *testing.T) {
		forceDisable, err := classifyCapabilityProbe(1, []any{int64(1), int64(64)}, quotaReported)
		if err != nil || forceDisable {
			t.Fatalf("forceDisable=%t err=%v, want false, nil", forceDisable, err)
		}
	})
	t.Run("index one rejects a negative usage probe", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(1, []any{int64(1), int64(-1)}, quotaReported); err == nil {
			t.Fatal("expected an error for a negative usage probe")
		}
	})
	t.Run("index one rejects a non-integer usage probe", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(1, []any{int64(1), "64"}, quotaReported); err == nil {
			t.Fatal("expected an error for a non-integer usage probe")
		}
	})
	t.Run("unknown status is rejected", func(t *testing.T) {
		if _, err := classifyCapabilityProbe(0, []any{int64(2), nil}, quotaReported); err == nil {
			t.Fatal("expected an error for an unknown probe status")
		}
	})
}

func TestDisposableCacheKeyAllowlist(t *testing.T) {
	store := NewStore(nil, "memory-unit")
	digest := queryDigest("test")
	for _, prefix := range disposableCachePrefixes {
		if !store.disposableCacheKey(store.Key(prefix)+digest, prefix) {
			t.Fatalf("cache not recognized: %s", prefix)
		}
		for _, key := range []string{
			"cao:other:" + prefix + digest, store.Key(prefix) + "session",
			store.Key(prefix) + digest + ":lock", store.Key("session:") + digest,
		} {
			if store.disposableCacheKey(key, prefix) {
				t.Fatalf("non-cache key accepted: %s", key)
			}
		}
	}
}

func TestMemoryCacheAdmissionRejectsInvalidResponsesAndTTL(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	bounded := NewStore(client, "memory-unit")
	if err := bounded.SetMaxMemoryBytes(4); err != nil {
		t.Fatal(err)
	}
	if err := bounded.CacheRepositoryMemoryCampaign(t.Context(), "campaign", []byte("large"), time.Second); err != nil {
		t.Fatal(err)
	}
	if stored, _, err := bounded.CacheQueryResult(t.Context(), queryDigest("large"), []byte("large"), 1024, 4096); err != nil || stored {
		t.Fatalf("oversized query admitted: stored=%t err=%v", stored, err)
	}
	if client.command != nil {
		t.Fatal("oversized cache payload reached Redis")
	}
	for _, reply := range []any{"OK", nil, int64(2)} {
		store := NewStore(queryCacheReplyClient{reply: reply}, "memory-unit")
		if err := store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", []byte("value"), time.Second); err == nil {
			t.Fatalf("malformed admission reply accepted: %v", reply)
		}
	}
	for _, reply := range []any{int64(0), int64(1)} {
		store := NewStore(queryCacheReplyClient{reply: reply}, "memory-unit")
		if err := store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", []byte("value"), time.Second); err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(queryCacheReplyClient{err: errors.New("unavailable")}, "memory-unit")
	if err := store.CacheMarketplaceRegistry(t.Context(), "registry", "revision", []byte("value"), time.Second); err == nil {
		t.Fatal("Redis error was hidden")
	}
	if err := store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", nil, time.Microsecond); err == nil {
		t.Fatal("sub-millisecond TTL was accepted")
	}
	for _, invalid := range []any{nil, []any{int64(0), []any{}}, []any{"invalid", []any{}}, []any{"0", int64(1)}} {
		if _, _, err := decodeCacheScan(invalid); err == nil {
			t.Fatalf("malformed cache scan accepted: %v", invalid)
		}
	}
}

func memoryIntegrationStore(t *testing.T) *Store {
	t.Helper()
	store, _ := queryCacheIntegrationStore(t)
	keys := []string{
		store.Key("marketplace:registry:" + marketplaceCacheKey("registry", "revision")),
		store.Key("repository-memory:campaign:" + repositoryMemoryCacheKey("campaign")),
		store.Key("repository-memory:cached-file:" + repositoryMemoryCacheKey("campaign", "commit", "file")),
		store.Key("session:protected"), store.Key("queue:protected"),
		store.Key("repository-memory:campaign:not-a-cache"),
		store.Key("quota:protected"), store.Key("revocations:protected"),
		"cao:foreign-" + strconv.FormatInt(time.Now().UnixNano(), 36) + ":marketplace:registry:" + queryDigest("foreign"),
	}
	for _, key := range keys[3:] {
		if _, err := store.Client.Do(t.Context(), "SET", key, "protected"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := store.Client.Do(ctx, append([]string{"DEL"}, keys...)...); err != nil {
			t.Errorf("clean up memory test: %v", err)
		}
	})
	t.Cleanup(func() {
		for _, key := range keys[3:] {
			value, err := store.Client.Do(context.Background(), "GET", key)
			if err != nil || value != "protected" {
				t.Errorf("protected state changed: value=%v err=%v", value, err)
			}
		}
	})
	// Warm every script before measuring a budget; script allocation is part of
	// whole-node usage and must not make the threshold depend on test order.
	payload := []byte("warm")
	if err := store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", payload, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.CacheQueryResult(t.Context(), queryDigest("warm"), payload, 1024, 64<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MaintainCaches(t.Context(), 64<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := store.memoryStats(t.Context(), keys[0]); err != nil {
		t.Fatal(err)
	}
	return store
}

func fillDisposableCaches(t *testing.T, store *Store) {
	t.Helper()
	payload := []byte(strings.Repeat("x", 64<<10))
	for _, write := range []func() error{
		func() error {
			return store.CacheMarketplaceRegistry(t.Context(), "registry", "revision", payload, time.Minute)
		},
		func() error {
			return store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", payload, time.Minute)
		},
		func() error {
			return store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", payload, time.Minute)
		},
	} {
		if err := write(); err != nil {
			t.Fatal(err)
		}
	}
	if stored, _, err := store.CacheQueryResult(t.Context(), queryDigest("query"), payload, 1<<20, 64<<20); err != nil || !stored {
		t.Fatalf("query admission: stored=%t err=%v", stored, err)
	}
}

func TestRedisMemoryBudgetReductionReclaimsOnlyDisposableCaches(t *testing.T) {
	store := memoryIntegrationStore(t)
	fillDisposableCaches(t, store)
	before, err := store.memoryStats(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	budget := before.UsedBytes - 200<<10
	if err := store.SetMaxMemoryBytes(budget); err != nil {
		t.Fatal(err)
	}
	stats, err := store.MaintainCaches(t.Context(), 64<<20)
	if err != nil || stats.UsedBytes > budget || stats.Evicted < 2 {
		t.Fatalf("maintenance: stats=%+v budget=%d err=%v", stats, budget, err)
	}
	actual, err := store.memoryStats(t.Context(), "")
	if err != nil || actual.UsedBytes > budget {
		t.Fatalf("actual memory is over budget: stats=%+v err=%v", actual, err)
	}
}

func TestRedisMemoryBudgetReportsUnreclaimablePressure(t *testing.T) {
	store := memoryIntegrationStore(t)
	fillDisposableCaches(t, store)
	if err := store.SetMaxMemoryBytes(1); err != nil {
		t.Fatal(err)
	}
	stats, err := store.MaintainCaches(t.Context(), 64<<20)
	if !errors.Is(err, ErrMemoryPressure) || stats.UsedBytes <= stats.BudgetBytes || stats.Evicted < 4 {
		t.Fatalf("unreclaimable pressure: stats=%+v err=%v", stats, err)
	}
	if !strings.Contains(err.Error(), "inspect provider memory and namespace/key-family usage") ||
		!strings.Contains(err.Error(), "preserve noeviction") ||
		!strings.Contains(err.Error(), "do not delete protected state") {
		t.Fatalf("pressure guidance is missing safe remediation: %v", err)
	}
	if err := store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", []byte("not admitted"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if value, err := store.CachedRepositoryMemoryFile(t.Context(), "campaign", "commit", "file"); err != nil || value != nil {
		t.Fatalf("cache grew under pressure: bytes=%d err=%v", len(value), err)
	}
	if stored, _, err := store.CacheQueryResult(t.Context(), queryDigest("query"), []byte("not admitted"), 1024, 64<<20); err != nil || stored {
		t.Fatalf("query cache grew under pressure: stored=%t err=%v", stored, err)
	}
}

func TestRedisMemoryBudgetConcurrentCacheAdmission(t *testing.T) {
	store := memoryIntegrationStore(t)
	const count = 16
	keys := make([]string, 0, count)
	for index := range count {
		keys = append(keys, store.Key("marketplace:registry:"+marketplaceCacheKey("concurrent", strconv.Itoa(index))))
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := store.Client.Do(ctx, append([]string{"DEL"}, keys...)...); err != nil {
			t.Errorf("clean up concurrent caches: %v", err)
		}
	})
	admit := func() {
		t.Helper()
		var group sync.WaitGroup
		failures := make(chan error, count)
		for index := range count {
			group.Go(func() {
				payload := []byte(strings.Repeat("x", 256<<10))
				if index%2 == 0 {
					if err := store.CacheMarketplaceRegistry(t.Context(), "concurrent", strconv.Itoa(index), payload, time.Minute); err != nil {
						failures <- err
					}
				} else if _, _, err := store.CacheQueryResult(t.Context(), queryDigest(fmt.Sprint(index)), payload, 1<<20, 64<<20); err != nil {
					failures <- err
				}
			})
		}
		group.Wait()
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
	}
	// Warm the connection pool's buffers before assigning a cache budget;
	// protected connection allocations are deliberately not evictable.
	admit()
	cacheKeys := append(append([]string{}, keys...),
		store.Key("{query-cache:v1}:entries"), store.Key("{query-cache:v1}:expiry"))
	if _, err := store.Client.Do(t.Context(), append([]string{"DEL"}, cacheKeys...)...); err != nil {
		t.Fatal(err)
	}
	before, err := store.memoryStats(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	budget := before.UsedBytes + 1<<20
	if err := store.SetMaxMemoryBytes(budget); err != nil {
		t.Fatal(err)
	}
	admit()
	stats, err := store.MaintainCaches(t.Context(), 64<<20)
	if err != nil || stats.UsedBytes > budget {
		t.Fatalf("concurrent caches exceed budget: stats=%+v err=%v", stats, err)
	}
}

func TestRedisMemoryBudgetHonorsProviderMaximum(t *testing.T) {
	store := memoryIntegrationStore(t)
	value, err := store.Client.Do(t.Context(), "INFO", "memory")
	if err != nil {
		t.Fatal(err)
	}
	info, ok := value.(string)
	if !ok {
		t.Fatal("invalid INFO response")
	}
	var maximum int64
	for _, line := range strings.Split(info, "\r\n") {
		if count, ok := strings.CutPrefix(line, "maxmemory:"); ok {
			maximum, err = strconv.ParseInt(count, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	expected := DefaultMaxMemoryBytes
	if maximum > 0 {
		expected = min(expected, maximum*4/5)
	}
	stats, err := store.memoryStats(t.Context(), "")
	if err != nil || stats.BudgetBytes != expected {
		t.Fatalf("provider budget: stats=%+v expected=%d err=%v", stats, expected, err)
	}
}
