package postgres

import (
	"testing"
	"time"
)

func TestAdvanceTokenBucketSpendsAndRefills(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := tokenBucket{Tokens: 4, At: start}

	b, r := advanceTokenBucket(b, start, 4, 1, time.Second)
	if !r.Allowed || r.Remaining != 3 || r.RetryAfter != 0 {
		t.Fatalf("unexpected result %+v", r)
	}
	if r.ResetAfter != 250*time.Millisecond {
		t.Fatalf("ResetAfter = %v", r.ResetAfter)
	}

	b, r = advanceTokenBucket(b, start.Add(500*time.Millisecond), 4, 1, time.Second)
	if !r.Allowed || r.Remaining != 3 || !b.At.Equal(start.Add(500*time.Millisecond)) {
		t.Fatalf("refill not capped or timestamp not advanced: %+v %+v", r, b)
	}
}

func TestAdvanceTokenBucketDenial(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	b, r := advanceTokenBucket(tokenBucket{Tokens: 0, At: start}, start, 2, 1, time.Second)
	if r.Allowed || r.RetryAfter != 500*time.Millisecond || b.Tokens != 0 {
		t.Fatalf("single-token denial: %+v %+v", r, b)
	}

	b, r = advanceTokenBucket(tokenBucket{Tokens: 1, At: start}, start, 4, 2, time.Second)
	if r.Allowed || b.Tokens != 0 || r.Remaining != 0 || r.RetryAfter != 500*time.Millisecond {
		t.Fatalf("multi-token denial should drain bucket: %+v %+v", r, b)
	}
}

func TestAdvanceTokenBucketIgnoresBackwardClock(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 10, 0, time.UTC)
	b, r := advanceTokenBucket(tokenBucket{Tokens: 1, At: start}, start.Add(-time.Hour), 2, 1, time.Second)
	if !r.Allowed || r.Remaining != 0 || !b.At.Equal(start) {
		t.Fatalf("backward clock changed state: %+v %+v", r, b)
	}
}
