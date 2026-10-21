package memory

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

func TestInactiveSessionTransfersAtReservedByteAndEntryCapacity(t *testing.T) {
	namespace := strings.Repeat("n", 64)
	s, clock := fixture(t, Config{
		MaxProtectedEntries: 1, MaxProtectedBytes: charge(namespace, "inactive", "sealed"),
		MaxSessions: 1, MaxRevocations: 1,
	})
	must(t, s.PutSession(t.Context(), "inactive", "sealed", time.Second, namespace))
	wantError(t, s.QueueRevocation(t.Context(), "unrelated", "sealed", namespace), operational.ErrCapacity)
	clock.Add(time.Second)
	must(t, s.Maintain(t.Context()))
	if record, err := s.SessionRecord(t.Context(), "inactive"); err != nil || record != "" {
		t.Fatal("expired session still grants authority")
	}
	saved, err := s.CompareSession(t.Context(), "inactive", "sealed", "late", time.Hour, namespace)
	must(t, err)
	if saved {
		t.Fatal("CAS resurrected expired authority")
	}
	pending, err := s.PendingRevocation(t.Context(), namespace)
	must(t, err)
	if pending.ID != "inactive" || pending.Value != "sealed" {
		t.Fatal("byte or entry pressure discarded inactive cleanup")
	}
	must(t, s.CompleteRevocation(t.Context(), pending.ID, pending.Value, namespace))
	must(t, s.PutSession(t.Context(), "inactive", "sealed", time.Hour, namespace))
	invariant(t, s)
}

func TestLogoutRefreshRaceAndConditionalCompletion(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	for i := range 100 {
		must(t, s.PutSession(ctx, "session", "old-encrypted", time.Hour, ""))
		start := make(chan struct{})
		var wg sync.WaitGroup
		var saved bool
		var refreshedErr, logoutErr error
		var staged string
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			saved, refreshedErr = s.CompareSession(ctx, "session", "old-encrypted", "rotated-encrypted", time.Hour, "")
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
		ok, err := s.CompareSession(ctx, "session", expected, "resurrected", time.Hour, "")
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
	must(t, s.PutSession(ctx, "session", "new", time.Hour, ""))
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
	must(t, s.PutSession(ctx, "one", "sealed", time.Second, ""))
	wantError(t, s.PutSession(ctx, "two", "sealed", time.Hour, ""), operational.ErrCapacity)
	must(t, s.QueueRevocation(ctx, "retry", "encrypted-one", "first:"))
	wantError(t, s.QueueRevocation(ctx, "retry", "encrypted-two", "second:"), operational.ErrCapacity)
	if record, _ := s.SessionRecord(ctx, "one"); record != "sealed" {
		t.Fatal("capacity pressure removed session")
	}
	staged, err := s.InvalidateSession(ctx, "one", "", "third:")
	must(t, err)
	if staged != "sealed" {
		t.Fatal("reserved cleanup capacity was not available")
	}
	first, _ := s.PendingRevocation(ctx, "first:")
	if first.Value != "encrypted-one" {
		t.Fatal("cleanup namespaces collided")
	}
	must(t, s.CompleteRevocation(ctx, "retry", "encrypted-one", "first:"))
	must(t, s.QueueRevocation(ctx, "retry", "encrypted-two", "second:"))
	clock.Add(25 * time.Hour)
	must(t, s.Maintain(ctx))
	pending, err := s.PendingRevocation(ctx, "third:")
	must(t, err)
	if pending.Value != "sealed" {
		t.Fatal("maintenance evicted pending revocation")
	}
	must(t, s.CompleteRevocation(ctx, "one", "sealed", "third:"))
	must(t, s.PutSession(ctx, "two", "new-session", time.Second, ""))
	clock.Add(time.Second)
	if record, _ := s.SessionRecord(ctx, "two"); record != "" {
		t.Fatal("session TTL not enforced")
	}
	pending, err = s.PendingRevocation(ctx, "")
	must(t, err)
	if pending.ID != "two" || pending.Value != "new-session" {
		t.Fatal("inactive session lost its cleanup owner at expiry")
	}
	invariant(t, s)
}

func TestNextRevocationOrdersAndWraps(t *testing.T) {
	revocations := map[revocationKey]revocationValue{
		{"a", "one"}: {"v1", 3}, {"a", "two"}: {"v2", 5}, {"b", "other"}: {"v3", 1},
	}
	for _, tt := range []struct {
		name, namespace string
		cursor, order   uint64
		id              string
		wrapped         bool
	}{
		{"empty cursor takes oldest", "a", 0, 3, "one", false},
		{"advances past cursor", "a", 3, 5, "two", false},
		{"wraps after last", "a", 5, 3, "one", true},
		{"other namespace isolated", "b", 0, 1, "other", false},
		{"unknown namespace empty", "c", 0, 0, "", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			key, order, wrapped := nextRevocation(revocations, tt.namespace, tt.cursor)
			if order != tt.order || key.id != tt.id || wrapped != tt.wrapped {
				t.Fatalf("got (%q, %d, %t), want (%q, %d, %t)", key.id, order, wrapped, tt.id, tt.order, tt.wrapped)
			}
		})
	}
}

func TestPendingRevocationRoundRobinsThroughStore(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	must(t, s.QueueRevocation(ctx, "one", "enc-1", "ns"))
	must(t, s.QueueRevocation(ctx, "two", "enc-2", "ns"))
	for _, want := range []string{"one", "two", "one"} {
		got, err := s.PendingRevocation(ctx, "ns")
		must(t, err)
		if got.ID != want {
			t.Fatalf("pending = %q, want %q", got.ID, want)
		}
	}
	empty, err := s.PendingRevocation(ctx, "other")
	must(t, err)
	if empty != (operational.Revocation{}) {
		t.Fatalf("empty namespace returned %+v", empty)
	}
}
