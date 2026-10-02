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

func TestClassifyLoadObservationIdentifiesEachRejectionReason(t *testing.T) {
	cases := []struct {
		name     string
		amount   float64
		halfLife time.Duration
		want     loadRejectionReason
	}{
		{"events", 1, time.Minute, loadRejectionReasonNone},
		{"Bad Name", 1, time.Minute, loadRejectionReasonNameOrHalfLife},
		{"events", 1, 0, loadRejectionReasonNameOrHalfLife},
		{"events", 1, 25 * time.Hour, loadRejectionReasonNameOrHalfLife},
		{"events", math.NaN(), time.Minute, loadRejectionReasonAmountNotFinite},
		{"events", math.Inf(1), time.Minute, loadRejectionReasonAmountNotFinite},
		{"events", -1, time.Minute, loadRejectionReasonAmountOutOfRange},
		{"events", 1e10, time.Minute, loadRejectionReasonAmountOutOfRange},
	}
	for _, testCase := range cases {
		if got := classifyLoadObservation(testCase.name, testCase.amount, testCase.halfLife); got != testCase.want {
			t.Errorf("classifyLoadObservation(%q, %v, %v) = %q, want %q",
				testCase.name, testCase.amount, testCase.halfLife, got, testCase.want)
		}
	}
}

func TestParseLoadRejectsMalformedValues(t *testing.T) {
	for _, value := range []any{"not-a-number", "NaN", "+Inf", "-1"} {
		if _, err := parseLoad(value); err == nil {
			t.Errorf("parseLoad(%v) accepted a malformed value", value)
		}
	}
	number, err := parseLoad("2.5")
	if err != nil || number != 2.5 {
		t.Fatalf("parseLoad(\"2.5\") = %v, %v", number, err)
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
