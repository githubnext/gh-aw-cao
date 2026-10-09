package redisx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func queryDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

type queryCacheReplyClient struct {
	reply any
	err   error
}

const testMemoryInfo = "# Memory\r\nused_memory:1024\r\nmaxmemory:0\r\n"

func testCacheCapabilityReply() []any {
	return []any{[]any{int64(1), testMemoryInfo}, []any{int64(1), nil}}
}

func (client queryCacheReplyClient) Do(_ context.Context, command ...string) (any, error) {
	if client.err == nil {
		if command[0] == "INFO" {
			return testMemoryInfo, nil
		}
		if command[0] == "EVAL" && command[1] == cacheCapabilityScript {
			return testCacheCapabilityReply(), nil
		}
	}
	return client.reply, client.err
}

func (queryCacheReplyClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected cache pipeline")
}

func TestDecodeQueryCacheReply(t *testing.T) {
	for _, test := range []struct {
		name       string
		reply      any
		maxBytes   int64
		wantErr    bool
		wantStats  QueryCacheStats
		wantResult any
	}{
		{
			name: "valid reply reports statistics", reply: []any{"value", int64(128), int64(2), int64(1), int64(3)},
			maxBytes: 4096, wantStats: QueryCacheStats{MemoryBytes: 128, Entries: 2, Expired: 1, Evicted: 3},
			wantResult: "value",
		},
		{name: "nil reply is rejected", reply: nil, maxBytes: 4096, wantErr: true},
		{name: "missing statistics is rejected", reply: []any{"value", int64(0)}, maxBytes: 4096, wantErr: true},
		{name: "negative memory is rejected", reply: []any{"value", int64(-1), int64(1), int64(0), int64(0)}, maxBytes: 4096, wantErr: true},
		{name: "string statistic is rejected", reply: []any{"value", "128", int64(1), int64(0), int64(0)}, maxBytes: 4096, wantErr: true},
		{name: "memory budget exceeded is rejected", reply: []any{"value", int64(4097), int64(1), int64(0), int64(0)}, maxBytes: 4096, wantErr: true},
		{
			name:  "entry limit exceeded is rejected",
			reply: []any{"value", int64(128), int64(QueryCacheMaxEntries + 1), int64(0), int64(0)}, maxBytes: 4096, wantErr: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, stats, err := decodeQueryCacheReply(test.reply, test.maxBytes)
			if test.wantErr {
				if err == nil {
					t.Fatal("invalid Redis reply was accepted")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result != test.wantResult || stats != test.wantStats {
				t.Fatalf("result=%v stats=%+v, want result=%v stats=%+v", result, stats, test.wantResult, test.wantStats)
			}
		})
	}
}

func TestQueryCacheRejectsMalformedRedisReplies(t *testing.T) {
	key := queryDigest("query")
	for _, test := range []struct {
		name  string
		reply any
	}{
		{"nil response", nil},
		{"missing statistics", []any{"value", int64(0)}},
		{"negative memory", []any{"value", int64(-1), int64(1), int64(0), int64(0)}},
		{"string statistics", []any{"value", "128", int64(1), int64(0), int64(0)}},
		{"memory budget exceeded", []any{"value", int64(4097), int64(1), int64(0), int64(0)}},
		{"entry limit exceeded", []any{"value", int64(128), int64(QueryCacheMaxEntries + 1), int64(0), int64(0)}},
		{"invalid payload type", []any{int64(1), int64(128), int64(1), int64(0), int64(0)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := NewStore(queryCacheReplyClient{reply: test.reply}, "reply-test")
			if _, _, err := store.CachedQueryResult(t.Context(), key, 1024, 4096); err == nil {
				t.Fatal("invalid Redis response was accepted")
			}
		})
	}
	for _, value := range []any{"1", int64(2), nil} {
		store := NewStore(queryCacheReplyClient{reply: []any{value, int64(128), int64(1), int64(0), int64(0)}}, "reply-test")
		if _, _, err := store.CacheQueryResult(t.Context(), key, []byte("value"), 1024, 4096); err == nil {
			t.Fatalf("invalid admission status accepted: %v", value)
		}
	}
	store := NewStore(queryCacheReplyClient{}, "reply-test")
	if _, _, err := store.CacheQueryResult(t.Context(), "invalid", []byte("too large"), 1, 1024); err == nil {
		t.Fatal("oversize bypass hid an invalid cache identity")
	}
}

func TestQueryCacheCommandAndAdmissionBounds(t *testing.T) {
	client := &marketplaceStoreCommandClient{}
	store := NewStore(client, "query-unit")
	key := queryDigest("query")
	if _, _, err := store.CacheQueryResult(t.Context(), key, []byte("12345"), 4, 1024); err != nil {
		t.Fatal(err)
	}
	if client.command != nil {
		t.Fatal("oversized result reached Redis")
	}
	if _, _, err := store.CachedQueryResult(t.Context(), "invalid", 1024, 4096); err == nil {
		t.Fatal("invalid query ETag was accepted")
	}
	if _, _, err := store.CachedQueryResult(t.Context(), key, 1024, 0); err == nil {
		t.Fatal("unbounded query cache was accepted")
	}
	if _, _, err := store.CachedQueryResult(t.Context(), key, 1024, 4096); err == nil {
		t.Fatal("unexpected Redis response was accepted")
	}
	command := client.command
	if command[0] != "EVAL" || command[2] != "2" ||
		command[3] != store.Key("{query-cache:v1}:entries") ||
		command[4] != store.Key("{query-cache:v1}:expiry") ||
		command[5] != "get" || command[6] != "300000" ||
		command[7] != "4096" || command[8] != "1024" || command[9] != key {
		t.Fatalf("unexpected cache command: %#v", command)
	}
}

func queryCacheIntegrationStore(t testing.TB) (*Store, []string) {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(url)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "query-cache-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	keys := []string{store.Key("{query-cache:v1}:entries"), store.Key("{query-cache:v1}:expiry")}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := client.Do(ctx, append([]string{"DEL"}, keys...)...); err != nil {
			t.Errorf("clean up query cache: %v", err)
		}
	})
	return store, keys
}

func TestQueryCacheNamespaceIsolationAndOperationalKeysAgainstRedis(t *testing.T) {
	first, firstKeys := queryCacheIntegrationStore(t)
	second, _ := queryCacheIntegrationStore(t)
	key := queryDigest("same-query")
	for _, store := range []*Store{first, second} {
		if stored, _, err := store.CacheQueryResult(t.Context(), key, []byte(store.Key("payload")), 1024, 4096); err != nil || !stored {
			t.Fatalf("namespace admission: stored=%t err=%v", stored, err)
		}
	}
	for _, store := range []*Store{first, second} {
		got, _, err := store.CachedQueryResult(t.Context(), key, 1024, 4096)
		if err != nil || string(got) != store.Key("payload") {
			t.Fatalf("namespace isolation: result=%s err=%v", got, err)
		}
	}
	sessionKey, queueKey := first.Key("session:sentinel"), first.Key("queue:sentinel")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := first.Client.Do(ctx, "DEL", sessionKey, queueKey); err != nil {
			t.Errorf("clean up operational sentinels: %v", err)
		}
	})
	if _, err := first.Client.Do(t.Context(), "SET", sessionKey, "session-value"); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Client.Do(t.Context(), "LPUSH", queueKey, "queue-value"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 16; i++ {
		if _, _, err := first.CacheQueryResult(t.Context(), queryDigest(strconv.Itoa(i)), []byte(strings.Repeat("x", 1024)), 1024, 4096); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := first.Client.Do(t.Context(), "DEL", firstKeys[1]); err != nil {
		t.Fatal(err)
	}
	if _, _, err := first.CachedQueryResult(t.Context(), key, 1024, 4096); err != nil {
		t.Fatal(err)
	}
	for _, command := range [][]string{{"GET", sessionKey}, {"LINDEX", queueKey, "0"}} {
		value, err := first.Client.Do(t.Context(), command...)
		expected := "session-value"
		if command[0] == "LINDEX" {
			expected = "queue-value"
		}
		if err != nil || value != expected {
			t.Fatalf("cache maintenance touched operational state: result=%v err=%v", value, err)
		}
	}
}

func TestQueryCacheConcurrentDuplicateAdmissionAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	key := queryDigest("duplicate-query")
	var group sync.WaitGroup
	failures := make(chan error, 32)
	for i := 0; i < 32; i++ {
		group.Go(func() {
			stored, _, err := store.CacheQueryResult(t.Context(), key, []byte("winner-"+strconv.Itoa(i)), 1024, 8192)
			if err != nil {
				failures <- err
			} else if !stored {
				failures <- fmt.Errorf("duplicate admission %d was not retained", i)
			}
		})
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	got, stats, err := store.CachedQueryResult(t.Context(), key, 1024, 8192)
	if err != nil || !strings.HasPrefix(string(got), "winner-") || stats.Entries != 1 {
		t.Fatalf("duplicate admission was not atomic: result=%s stats=%+v err=%v", got, stats, err)
	}
	count, err := store.Client.Do(t.Context(), "HLEN", keys[0])
	if err != nil || count != int64(1) {
		t.Fatalf("duplicate admission retained multiple payloads: count=%v err=%v", count, err)
	}
}

func TestQueryCacheLargeBudgetReductionAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	payload := []byte(strings.Repeat("x", 4096))
	for i := 0; i < QueryCacheMaxEntries; i++ {
		if stored, _, err := store.CacheQueryResult(t.Context(), queryDigest(strconv.Itoa(i)), payload, 4096, 64<<20); err != nil || !stored {
			t.Fatalf("populate cache: stored=%t err=%v", stored, err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	const reducedBudget = 16 << 10
	_, stats, err := store.CachedQueryResult(ctx, queryDigest("1023"), 4096, reducedBudget)
	if err != nil || stats.MemoryBytes > reducedBudget || stats.Evicted < QueryCacheMaxEntries/2 {
		t.Fatalf("budget reduction: stats=%+v err=%v", stats, err)
	}
	if actual := cacheMemory(t, store, keys); actual > reducedBudget {
		t.Fatalf("cache exceeds reduced memory budget: stats=%d actual=%d budget=%d", stats.MemoryBytes, actual, reducedBudget)
	}
}
func cacheMemory(t *testing.T, store *Store, keys []string) int64 {
	t.Helper()
	var total int64
	for _, key := range keys {
		value, err := store.Client.Do(t.Context(), "MEMORY", "USAGE", key, "SAMPLES", "0")
		if err != nil {
			t.Fatal(err)
		}
		if value != nil {
			number, err := strconv.ParseInt(fmt.Sprint(value), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			total += number
		}
	}
	return total
}

func TestQueryCacheTTLAndOldestEvictionAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	const budget = 12 << 10
	data := []byte(strings.Repeat("x", 2048))
	first := queryDigest("first")
	if stored, _, err := store.CacheQueryResult(t.Context(), first, data, 2048, budget); err != nil || !stored {
		t.Fatalf("initial admission: stored=%t err=%v", stored, err)
	}
	deadline, err := store.Client.Do(t.Context(), "ZSCORE", keys[1], first)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		value, err := store.Client.Do(t.Context(), "PTTL", key)
		if err != nil {
			t.Fatal(err)
		}
		ttl, _ := strconv.ParseInt(fmt.Sprint(value), 10, 64)
		if ttl <= QueryCacheTTL.Milliseconds()-5000 || ttl > QueryCacheTTL.Milliseconds() {
			t.Fatalf("unexpected cache key TTL: %d", ttl)
		}
	}
	time.Sleep(5 * time.Millisecond)
	if got, _, err := store.CachedQueryResult(t.Context(), first, 2048, budget); err != nil || string(got) != string(data) {
		t.Fatalf("cache hit: bytes=%d err=%v", len(got), err)
	}
	if _, _, err := store.CacheQueryResult(t.Context(), first, []byte("replacement"), 2048, budget); err != nil {
		t.Fatal(err)
	}
	after, err := store.Client.Do(t.Context(), "ZSCORE", keys[1], first)
	if err != nil || deadline != after {
		t.Fatalf("read or duplicate admission renewed entry: before=%v after=%v err=%v", deadline, after, err)
	}
	last := ""
	for i := 0; i < 12; i++ {
		last = queryDigest(strconv.Itoa(i))
		if stored, stats, err := store.CacheQueryResult(t.Context(), last, data, 2048, budget); err != nil || !stored {
			t.Fatalf("admission %d: stored=%t err=%v", i, stored, err)
		} else if stats.MemoryBytes > budget || stats.Entries <= 0 {
			t.Fatalf("invalid cache statistics: %+v", stats)
		}
		if used := cacheMemory(t, store, keys); used > budget {
			t.Fatalf("cache memory = %d, budget = %d", used, budget)
		}
	}
	if got, _, err := store.CachedQueryResult(t.Context(), first, 2048, budget); err != nil || got != nil {
		t.Fatalf("oldest entry was not retired: bytes=%d err=%v", len(got), err)
	}
	if got, _, err := store.CachedQueryResult(t.Context(), last, 2048, budget); err != nil || got == nil {
		t.Fatalf("newest entry was not retained: bytes=%d err=%v", len(got), err)
	}
}

// TestQueryCacheBulkExpiryRemovesAllEntriesAgainstRedis covers the batched
// HDEL/ZREM path: several entries expiring in the same maintenance pass must
// all be removed from both the hash and the expiry index, leaving no
// partially-cleaned keys and no residual memory.
func TestQueryCacheBulkExpiryRemovesAllEntriesAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	const count = 37
	data := []byte(strings.Repeat("x", 256))
	expiring := make([]string, count)
	for i := 0; i < count; i++ {
		expiring[i] = queryDigest("bulk-expiring-" + strconv.Itoa(i))
		if stored, _, err := store.CacheQueryResult(t.Context(), expiring[i], data, 1024, 1<<20); err != nil || !stored {
			t.Fatalf("admission %d: stored=%t err=%v", i, stored, err)
		}
	}
	survivor := queryDigest("bulk-survivor")
	if stored, _, err := store.CacheQueryResult(t.Context(), survivor, data, 1024, 1<<20); err != nil || !stored {
		t.Fatalf("survivor admission: stored=%t err=%v", stored, err)
	}
	for _, key := range expiring {
		if _, err := store.Client.Do(t.Context(), "ZADD", keys[1], "0", key); err != nil {
			t.Fatal(err)
		}
	}
	if got, stats, err := store.CachedQueryResult(t.Context(), survivor, 1024, 1<<20); err != nil || string(got) != string(data) {
		t.Fatalf("survivor cache hit: bytes=%d err=%v", len(got), err)
	} else if stats.Expired != count {
		t.Fatalf("expired count = %d, want %d", stats.Expired, count)
	}
	for _, key := range expiring {
		if got, err := store.Client.Do(t.Context(), "HEXISTS", keys[0], key); err != nil || got != int64(0) {
			t.Fatalf("expired entry %s remained in the hash: exists=%v err=%v", key, got, err)
		}
		if got, err := store.Client.Do(t.Context(), "ZSCORE", keys[1], key); err != nil || got != nil {
			t.Fatalf("expired entry %s remained in the index: score=%v err=%v", key, got, err)
		}
	}
	if got, _, err := store.CachedQueryResult(t.Context(), survivor, 1024, 1<<20); err != nil || string(got) != string(data) {
		t.Fatalf("survivor retained after bulk expiry: bytes=%d err=%v", len(got), err)
	}
}

func TestQueryCacheExpiryAndPartialEvictionAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	key := queryDigest("expiring")
	admit := func() {
		t.Helper()
		if stored, _, err := store.CacheQueryResult(t.Context(), key, []byte("value"), 1024, 8192); err != nil || !stored {
			t.Fatalf("admission: stored=%t err=%v", stored, err)
		}
	}
	admit()
	// Advance the entry's deadline without waiting five minutes.
	if _, err := store.Client.Do(t.Context(), "ZADD", keys[1], "0", key); err != nil {
		t.Fatal(err)
	}
	if got, stats, err := store.CachedQueryResult(t.Context(), key, 1024, 8192); err != nil || got != nil {
		t.Fatalf("expired entry was served: bytes=%d err=%v", len(got), err)
	} else if stats.Expired != 1 || stats.Entries != 0 || stats.MemoryBytes != 0 {
		t.Fatalf("expired entry accounting: %+v", stats)
	}
	if used := cacheMemory(t, store, keys); used != 0 {
		t.Fatalf("expired cache retained %d bytes", used)
	}
	for _, removed := range keys {
		admit()
		if _, err := store.Client.Do(t.Context(), "DEL", removed); err != nil {
			t.Fatal(err)
		}
		if got, _, err := store.CachedQueryResult(t.Context(), key, 1024, 8192); err != nil || got != nil {
			t.Fatalf("partially evicted cache was served: bytes=%d err=%v", len(got), err)
		}
		if used := cacheMemory(t, store, keys); used != 0 {
			t.Fatalf("partially evicted cache retained %d bytes", used)
		}
		admit()
		if got, stats, err := store.CachedQueryResult(t.Context(), key, 4, 8192); err != nil || got != nil || stats.Evicted != 1 {
			t.Fatalf("lowered result-size limit was not enforced: bytes=%d stats=%+v err=%v", len(got), stats, err)
		}
		admit()
		if _, err := store.Client.Do(t.Context(), "ZREM", keys[1], key); err != nil {
			t.Fatal(err)
		}
		if got, _, err := store.CachedQueryResult(t.Context(), key, 1024, 8192); err != nil || got != nil {
			t.Fatalf("entry without an expiry deadline was served: bytes=%d err=%v", len(got), err)
		}
	}
}

func TestQueryCacheConcurrentBudgetAndEntryLimitAgainstRedis(t *testing.T) {
	store, keys := queryCacheIntegrationStore(t)
	const budget = 32 << 10
	data := []byte(strings.Repeat("x", 1024))
	var group sync.WaitGroup
	failures := make(chan error, 64)
	for i := 0; i < 64; i++ {
		group.Go(func() {
			_, _, err := store.CacheQueryResult(t.Context(), queryDigest(strconv.Itoa(i)), data, 1024, budget)
			if err != nil {
				failures <- err
			}
		})
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if used := cacheMemory(t, store, keys); used > budget {
		t.Fatalf("concurrent admissions used %d bytes, budget %d", used, budget)
	}
	if _, err := store.Client.Do(t.Context(), append([]string{"DEL"}, keys...)...); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= QueryCacheMaxEntries; i++ {
		if _, _, err := store.CacheQueryResult(t.Context(), queryDigest(strconv.Itoa(i)), []byte("x"), 1024, 8<<20); err != nil {
			t.Fatal(err)
		}
	}
	count, err := store.Client.Do(t.Context(), "ZCARD", keys[1])
	if err != nil || fmt.Sprint(count) != strconv.Itoa(QueryCacheMaxEntries) {
		t.Fatalf("entry count=%v err=%v", count, err)
	}
}
