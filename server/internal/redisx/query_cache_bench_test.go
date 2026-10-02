package redisx

import (
	"strconv"
	"strings"
	"testing"
)

func populateBenchmarkCache(b *testing.B, store *Store) {
	b.Helper()
	payload := []byte(strings.Repeat("x", 4096))
	for i := 0; i < QueryCacheMaxEntries; i++ {
		if stored, _, err := store.CacheQueryResult(b.Context(), queryDigest(strconv.Itoa(i)), payload, 4096, 64<<20); err != nil || !stored {
			b.Fatalf("populate benchmark cache: stored=%t err=%v", stored, err)
		}
	}
}

func BenchmarkQueryCacheFullHit(b *testing.B) {
	store, _ := queryCacheIntegrationStore(b)
	populateBenchmarkCache(b, store)
	key := queryDigest("512")
	b.ReportAllocs()
	b.SetBytes(4096)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, _, err := store.CachedQueryResult(b.Context(), key, 4096, 64<<20)
		if err != nil || len(data) != 4096 {
			b.Fatalf("cache hit: bytes=%d err=%v", len(data), err)
		}
	}
}

func BenchmarkQueryCacheBudgetRetirement(b *testing.B) {
	store, keys := queryCacheIntegrationStore(b)
	key := queryDigest("1023")
	b.ReportAllocs()
	var retired int64
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		if _, err := store.Client.Do(b.Context(), "DEL", keys[0], keys[1]); err != nil {
			b.Fatal(err)
		}
		populateBenchmarkCache(b, store)
		b.StartTimer()
		_, stats, err := store.CachedQueryResult(b.Context(), key, 4096, 16<<10)
		if err != nil || stats.MemoryBytes > 16<<10 {
			b.Fatalf("budget retirement: stats=%+v err=%v", stats, err)
		}
		retired += stats.Evicted
	}
	b.ReportMetric(float64(retired)/float64(b.N), "retired/op")
}
