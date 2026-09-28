package collect

import (
	"errors"
	"testing"
	"time"
)

func TestDecideRetryReschedulesBeforeAttemptsExhausted(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	wantBackoff := 5 * time.Second
	backoffFor := func(attempt int) time.Duration {
		if attempt != 1 {
			t.Fatalf("backoffFor called with attempt = %d, want 1", attempt)
		}
		return wantBackoff
	}
	decision := decideRetry(Task{Repository: "octo/api", Attempt: 0}, errors.New("boom"), 5, now, backoffFor)
	if decision.deadLetter {
		t.Fatal("deadLetter = true, want false while attempts remain")
	}
	if decision.task.Attempt != 1 {
		t.Fatalf("task.Attempt = %d, want 1", decision.task.Attempt)
	}
	if !decision.task.NotBefore.Equal(now.Add(wantBackoff)) {
		t.Fatalf("task.NotBefore = %v, want %v", decision.task.NotBefore, now.Add(wantBackoff))
	}
}

func TestDecideRetryDeadLettersOnceAttemptsAreExhausted(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	backoffFor := func(int) time.Duration {
		t.Fatal("backoffFor must not be called once attempts are exhausted")
		return 0
	}
	decision := decideRetry(Task{Repository: "octo/api", Attempt: 4}, errors.New("still failing"), 5, now, backoffFor)
	if !decision.deadLetter {
		t.Fatal("deadLetter = false, want true once attempts are exhausted")
	}
	if decision.task.Attempt != 5 {
		t.Fatalf("task.Attempt = %d, want 5", decision.task.Attempt)
	}
	if decision.reason != "still failing" {
		t.Fatalf("reason = %q, want %q", decision.reason, "still failing")
	}
	if !decision.task.NotBefore.IsZero() {
		t.Fatalf("task.NotBefore = %v, want zero for a dead-lettered task", decision.task.NotBefore)
	}
}

func TestDecideRetryDefaultsReasonWhenCauseIsNil(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	decision := decideRetry(Task{Repository: "octo/api", Attempt: 4}, nil, 5, now, func(int) time.Duration { return 0 })
	if !decision.deadLetter {
		t.Fatal("deadLetter = false, want true once attempts are exhausted")
	}
	if decision.reason != "unknown failure" {
		t.Fatalf("reason = %q, want %q", decision.reason, "unknown failure")
	}
}

func TestDecideRetryBoundaryAtExactlyMaxAttempts(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// Starting at Attempt=0 with maxAttempts=1 means the very first failure
	// already exhausts the budget, so the boundary check (>=) must trigger on
	// the first retry rather than requiring a strictly-greater count.
	decision := decideRetry(Task{Repository: "octo/api", Attempt: 0}, errors.New("x"), 1, now, func(int) time.Duration { return 0 })
	if !decision.deadLetter {
		t.Fatal("deadLetter = false, want true when maxAttempts is reached on the first retry")
	}
	if decision.task.Attempt != 1 {
		t.Fatalf("task.Attempt = %d, want 1", decision.task.Attempt)
	}
}
