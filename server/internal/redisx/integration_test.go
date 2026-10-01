package redisx

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestOperationalRateLimitAgainstRedis(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}

	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}

	store := NewStore(client, "integration-"+strconv.FormatInt(time.Now().UnixNano(), 36))
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
}

func TestRepositoryMemoryCacheExpiryAgainstRedis(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "memory-integration-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for index, revision := range []string{"first", "second", "first"} {
		number := int64(1)
		if index == 1 {
			number = 2
		}
		if err := store.PutRepositoryMemory(ctx, revision, number, []byte("manifest"), nil); err != nil {
			t.Fatal(err)
		}
	}
	for revision, want := range map[string]int64{"first": 604800, "second": -1} {
		value, err := client.Do(ctx, "TTL", store.repositoryMemoryRevisionKey(revision))
		if err != nil {
			t.Fatal(err)
		}
		got := toInt64(value)
		if revision == "first" && (got < want-5 || got > want) || revision == "second" && got != want {
			t.Fatalf("%s TTL = %d, want %d", revision, got, want)
		}
	}
}
