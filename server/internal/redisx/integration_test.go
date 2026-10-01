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
