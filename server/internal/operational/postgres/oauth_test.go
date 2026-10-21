package postgres

import (
	"strings"
	"testing"
	"time"
)

func TestInactiveSessionExpiryRetainsCleanupAcrossRestartAtCapacity(t *testing.T) {
	config := Config{MaxProtectedEntries: 2}
	store, dsn := testStore(t, config)
	namespace := strings.Repeat("n", 1024)
	if err := store.PutSession(t.Context(), "inactive", "sealed-unknown-expiry", time.Hour, namespace); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `UPDATE cao_operational_records SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND kind='session'`, store.namespace); err != nil {
		t.Fatal(err)
	}
	if err := store.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PendingRevocation(t.Context(), namespace); err == nil {
		t.Fatal("closed storage reported successful cleanup")
	}
	restarted, err := Open(t.Context(), dsn, store.namespace, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	if value, err := restarted.SessionRecord(t.Context(), "inactive"); err != nil || value != "" {
		t.Fatal("expired authority survived restart")
	}
	if saved, err := restarted.CompareSession(t.Context(), "inactive", "sealed-unknown-expiry", "late", time.Hour, namespace); err != nil || saved {
		t.Fatal("late refresh restored expired authority")
	}
	pending, err := restarted.PendingRevocation(t.Context(), namespace)
	if err != nil || pending.ID != "inactive" || pending.Value != "sealed-unknown-expiry" {
		t.Fatalf("restart or maintenance lost cleanup at protected capacity: %+v %v", pending, err)
	}
	if err := restarted.CompleteRevocation(t.Context(), pending.ID, pending.Value, namespace); err != nil {
		t.Fatal(err)
	}
	health, err := restarted.Health(t.Context())
	if err != nil || health.Entries != 0 {
		t.Fatalf("completion leaked reserved capacity: %+v %v", health, err)
	}
}
