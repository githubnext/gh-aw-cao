package memory

import (
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestClassifyLockAttempt(t *testing.T) {
	for _, tc := range []struct {
		name        string
		alreadyHeld bool
		count, max  int
		want        lockAttemptOutcome
	}{
		{"acquires below capacity", false, 0, 2, lockAttemptAcquired},
		{"already held takes priority over capacity", true, 2, 2, lockAttemptHeld},
		{"at capacity when count equals max", false, 2, 2, lockAttemptAtCapacity},
		{"over capacity", false, 3, 2, lockAttemptAtCapacity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyLockAttempt(tc.alreadyHeld, tc.count, tc.max); got != tc.want {
				t.Fatalf("classifyLockAttempt(%t, %d, %d) = %q, want %q", tc.alreadyHeld, tc.count, tc.max, got, tc.want)
			}
		})
	}
}

// TestTryLockAtCapacityRejectsNewNameButNotReacquisition exercises TryLock's
// real capacity-rejection branch against a *Store, verifying that a brand
// new lock name is refused once MaxLocks is reached while the already-held
// lock remains renewable and unaffected by the rejected attempt.
func TestTryLockAtCapacityRejectsNewNameButNotReacquisition(t *testing.T) {
	s, _ := fixture(t, Config{MaxLocks: 1})
	ctx := t.Context()
	ok, err := s.TryLock(ctx, "first", "owner", time.Second)
	must(t, err)
	if !ok {
		t.Fatal("first lock should acquire under budget")
	}
	ok, err = s.TryLock(ctx, "second", "owner", time.Second)
	wantError(t, err, operational.ErrCapacity)
	if ok {
		t.Fatal("second lock should not acquire at capacity")
	}
	if ok, _ := s.TryLock(ctx, "first", "owner", time.Second); ok {
		t.Fatal("already-held lock must report held, not acquired")
	}
	held, err := s.LockHeld(ctx, "first")
	must(t, err)
	if !held {
		t.Fatal("rejected attempt on a different name must not disturb the held lock")
	}
	invariant(t, s)
}
