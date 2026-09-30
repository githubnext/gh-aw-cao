package redisx

import (
	"context"
	"math"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestLoadRejectsUnboundedNamesAndAmounts(t *testing.T) {
	store := NewStore(&ingestionHealthCommandClient{}, "load-test")
	for _, name := range []string{"../../token", "Foo", "", "a:b"} {
		if _, err := store.AddLoad(t.Context(), name, 1, time.Minute); err == nil {
			t.Errorf("accepted load name %q", name)
		}
	}
	for _, amount := range []float64{-1, math.NaN(), math.Inf(1), 1e10} {
		if _, err := store.AddLoad(t.Context(), "events", amount, time.Minute); err == nil {
			t.Errorf("accepted load amount %v", amount)
		}
	}
	if _, err := store.Loads(t.Context(), []string{"events"}, 0); err == nil {
		t.Fatal("accepted a zero half-life")
	}
}

func TestDistributedLoadDecaysWithoutRefreshingOnRead(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "load-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	peer := NewStore(client, store.namespace)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	if value, err := store.AddLoad(ctx, "events", 2, time.Second); err != nil || value != 2 {
		t.Fatalf("first observation = %v, %v", value, err)
	}
	values, err := peer.Loads(ctx, []string{"events", "absent"}, time.Second)
	if err != nil || values["events"] <= 0 || values["events"] > 2 || values["absent"] != 0 {
		t.Fatalf("distributed snapshot = %v, %v", values, err)
	}
	time.Sleep(1100 * time.Millisecond)
	values, err = peer.Loads(ctx, []string{"events"}, time.Second)
	if err != nil || values["events"] <= 0 || values["events"] >= 1.1 {
		t.Fatalf("decayed snapshot = %v, %v", values, err)
	}
	if err := store.IncrementIngestionCounter(ctx, "collectionSucceeded"); err != nil {
		t.Fatal(err)
	}
	values, err = peer.Loads(ctx, []string{"collection"}, time.Minute)
	if err != nil || values["collection"] <= 0 || values["collection"] > 1 {
		t.Fatalf("ingestion event load = %v, %v", values, err)
	}
}
