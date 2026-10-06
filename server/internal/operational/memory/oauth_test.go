package memory

import (
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestLogoutRefreshRaceAndConditionalCompletion(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	for i := range 100 {
		must(t, s.PutSession(ctx, "session", "old-encrypted", time.Hour))
		start := make(chan struct{})
		var wg sync.WaitGroup
		var saved bool
		var refreshedErr, logoutErr error
		var staged string
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			saved, refreshedErr = s.CompareSession(ctx, "session", "old-encrypted", "rotated-encrypted", time.Hour)
		}()
		go func() {
			defer wg.Done()
			<-start
			staged, logoutErr = s.InvalidateSession(ctx, "session", "", "revocations:opaque:")
		}()
		close(start)
		wg.Wait()
		must(t, refreshedErr)
		must(t, logoutErr)
		expected := "old-encrypted"
		if saved {
			expected = "rotated-encrypted"
		}
		if staged != expected {
			t.Fatalf("iteration %d staged %q, want %q", i, staged, expected)
		}
		if record, _ := s.SessionRecord(ctx, "session"); record != "" {
			t.Fatal("logout retained session")
		}
		ok, err := s.CompareSession(ctx, "session", expected, "resurrected", time.Hour)
		must(t, err)
		if ok {
			t.Fatal("refresh resurrected logged-out session")
		}
		pending, err := s.PendingRevocation(ctx, "revocations:opaque:")
		must(t, err)
		if pending.ID != "session" || pending.Value != expected {
			t.Fatalf("pending = %#v", pending)
		}
		must(t, s.CompleteRevocation(ctx, "session", expected, "revocations:opaque:"))
	}
	must(t, s.PutSession(ctx, "session", "new", time.Hour))
	_, err := s.InvalidateSession(ctx, "session", "stale", "revocations:")
	wantError(t, err, operational.ErrConflict)
	if record, _ := s.SessionRecord(ctx, "session"); record != "new" {
		t.Fatal("superseded invalidation removed session")
	}
	must(t, s.QueueRevocation(ctx, "retry", "first", "revocations:"))
	must(t, s.QueueRevocation(ctx, "retry", "replacement", "revocations:"))
	must(t, s.CompleteRevocation(ctx, "retry", "first", "revocations:"))
	pending, err := s.PendingRevocation(ctx, "revocations:")
	must(t, err)
	if pending.Value != "replacement" {
		t.Fatal("stale completion removed replacement revocation")
	}
	must(t, s.CompleteRevocation(ctx, pending.ID, pending.Value, "revocations:"))
	must(t, s.DeleteSession(ctx, "session"))
	invariant(t, s)
}

func TestOAuthCapacityNamespacesRetryAndExpiry(t *testing.T) {
	config := DefaultConfig()
	config.MaxSessions, config.MaxRevocations = 1, 2
	s, clock := fixture(t, config)
	ctx := t.Context()
	must(t, s.PutSession(ctx, "one", "sealed", time.Second))
	wantError(t, s.PutSession(ctx, "two", "sealed", time.Hour), operational.ErrCapacity)
	must(t, s.QueueRevocation(ctx, "retry", "encrypted-one", "first:"))
	must(t, s.QueueRevocation(ctx, "retry", "encrypted-two", "second:"))
	_, err := s.InvalidateSession(ctx, "one", "", "third:")
	wantError(t, err, operational.ErrCapacity)
	if record, _ := s.SessionRecord(ctx, "one"); record != "sealed" {
		t.Fatal("failed staging partially removed session")
	}
	first, _ := s.PendingRevocation(ctx, "first:")
	second, _ := s.PendingRevocation(ctx, "second:")
	if first.Value != "encrypted-one" || second.Value != "encrypted-two" {
		t.Fatal("opaque namespaces collided")
	}
	must(t, s.CompleteRevocation(ctx, "retry", "encrypted-one", "first:"))
	staged, err := s.InvalidateSession(ctx, "one", "", "third:")
	must(t, err)
	if staged != "sealed" {
		t.Fatal("session not staged after capacity released")
	}
	clock.Add(25 * time.Hour)
	must(t, s.Maintain(ctx))
	pending, err := s.PendingRevocation(ctx, "third:")
	must(t, err)
	if pending.Value != "sealed" {
		t.Fatal("maintenance evicted pending revocation")
	}
	must(t, s.PutSession(ctx, "two", "new-session", time.Second))
	clock.Add(time.Second)
	if record, _ := s.SessionRecord(ctx, "two"); record != "" {
		t.Fatal("session TTL not enforced")
	}
	invariant(t, s)
}
