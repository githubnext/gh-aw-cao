package redisx

import (
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestOAuthInactiveExpiryAndRestartAgainstRedis(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is required for real Redis OAuth lifecycle tests")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "oauth-expiry-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	store := NewStore(client, prefix)
	t.Cleanup(func() { _ = store.Close() })
	const id = "inactive"
	cleanupPrefix := prefix + ":durable:"
	if err := store.PutSession(t.Context(), id, "sealed-unknown-expiry", 20*time.Millisecond, cleanupPrefix); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if value, err := store.SessionRecord(t.Context(), id); err != nil || value != "" {
		t.Fatalf("inactive session retained authority: %q %v", value, err)
	}
	if saved, err := store.CompareSession(t.Context(), id, "sealed-unknown-expiry", "resurrected", time.Hour, cleanupPrefix); err != nil || saved {
		t.Fatal("refresh resurrected expired authority")
	}
	otherClient, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	// The worker restarts with a different disposable namespace but the same
	// stable cleanup prefix, as hosted restarts do.
	restarted := NewStore(otherClient, prefix+"-replacement")
	t.Cleanup(func() { _ = restarted.Close() })
	pending, err := restarted.PendingRevocation(t.Context(), cleanupPrefix)
	if err != nil || pending.Value != "sealed-unknown-expiry" {
		t.Fatalf("restart lost inactive cleanup: %+v %v", pending, err)
	}
	if err := restarted.CompleteRevocation(t.Context(), id, "stale", cleanupPrefix); err != nil {
		t.Fatal(err)
	}
	if pending, err := restarted.PendingRevocation(t.Context(), cleanupPrefix); err != nil || pending.Value == "" {
		t.Fatal("stale completion removed cleanup")
	}
	if err := restarted.CompleteRevocation(t.Context(), id, "sealed-unknown-expiry", cleanupPrefix); err != nil {
		t.Fatal(err)
	}
	if pending, err := restarted.PendingRevocation(t.Context(), cleanupPrefix); err != nil || pending.Value != "" {
		t.Fatal("cleanup completion did not release the record")
	}
}

func TestOAuthLogoutRefreshAndExpiryCASAgainstRedis(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is required for real Redis OAuth lifecycle tests")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "oauth-race-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	store := NewStore(client, prefix)
	t.Cleanup(func() { _ = store.Close() })
	for i := range 20 {
		id := strconv.Itoa(i)
		if err := store.PutSession(t.Context(), id, "old", time.Hour, prefix); err != nil {
			t.Fatal(err)
		}
		var saved bool
		var staged string
		var refreshErr, logoutErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			saved, refreshErr = store.CompareSession(t.Context(), id, "old", "new", time.Hour, prefix)
		}()
		go func() {
			defer wg.Done()
			staged, logoutErr = store.InvalidateSession(t.Context(), id, "", prefix)
		}()
		wg.Wait()
		if refreshErr != nil || logoutErr != nil {
			t.Fatalf("refresh/logout failed: %v %v", refreshErr, logoutErr)
		}
		want := "old"
		if saved {
			want = "new"
		}
		if staged != want {
			t.Fatal("logout staged stale credentials")
		}
		if saved, err := store.CompareSession(t.Context(), id, want, "late", time.Hour, prefix); err != nil || saved {
			t.Fatal("late refresh restored logged-out authority")
		}
		if err := store.CompleteRevocation(t.Context(), id, want, prefix); err != nil {
			t.Fatal(err)
		}
	}
	// Direct deletion must also transfer cleanup, not destroy it.
	if err := store.PutSession(t.Context(), "delete", "retained", time.Hour, prefix); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteSession(t.Context(), "delete"); err != nil {
		t.Fatal(err)
	}
	if pending, err := store.PendingRevocation(t.Context(), prefix); err != nil || pending.Value != "retained" {
		t.Fatal("direct deletion abandoned cleanup")
	}
	if err := store.CompleteRevocation(t.Context(), "delete", "retained", prefix); err != nil {
		t.Fatal(err)
	}
}
