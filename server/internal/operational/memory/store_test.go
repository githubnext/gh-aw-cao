package memory

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type testClock struct{ nanos atomic.Int64 }

func (c *testClock) Now() time.Time      { return time.Unix(0, c.nanos.Load()).UTC() }
func (c *testClock) Add(d time.Duration) { c.nanos.Add(int64(d)) }

func fixture(t *testing.T, config Config) (*Store, *testClock) {
	t.Helper()
	clock := &testClock{}
	clock.nanos.Store(time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC).UnixNano())
	config.Clock = clock.Now
	s, err := New(config)
	must(t, err)
	t.Cleanup(func() { must(t, s.Close()) })
	return s, clock
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantError(t *testing.T, err, expected error) {
	t.Helper()
	if !errors.Is(err, expected) {
		t.Fatalf("error = %v, want %v", err, expected)
	}
}

func invariant(t *testing.T, s *Store) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	var protected, meta, taskBytes int64
	var metaCount, tasks, leases, reservations int
	for k, n := range s.records {
		protected += n
		if metadata(k) {
			meta += n
			metaCount++
		}
	}
	for _, q := range s.queues {
		tasks += len(q.tasks)
		for _, task := range q.tasks {
			taskBytes += task.bytes
		}
		for _, g := range q.groups {
			leases += len(g.pending)
		}
	}
	for _, scheduled := range s.delayed {
		tasks += len(scheduled)
		for _, task := range scheduled {
			taskBytes += task.task.bytes
		}
	}
	for _, q := range s.quotas {
		reservations += len(q.reservations)
	}
	if protected != s.protectedBytes || meta != s.metadataBytes || metaCount != s.metadataEntries ||
		tasks != s.taskCount || taskBytes != s.taskBytes || leases != s.leaseCount || reservations != s.quotaReservations {
		t.Fatalf("accounting drift: bytes %d/%d meta %d/%d entries %d/%d tasks %d/%d taskBytes %d/%d leases %d/%d reservations %d/%d",
			protected, s.protectedBytes, meta, s.metadataBytes, metaCount, s.metadataEntries,
			tasks, s.taskCount, taskBytes, s.taskBytes, leases, s.leaseCount, reservations, s.quotaReservations)
	}
	var cacheBytes int64
	for _, e := range s.cache {
		cacheBytes += e.bytes
	}
	if cacheBytes != s.cacheBytes || cacheBytes > s.config.MaxCacheBytes ||
		len(s.cache) > s.config.MaxCacheEntries || protected > s.config.MaxProtectedBytes ||
		meta > s.config.MaxMetadataBytes || metaCount > s.config.MaxMetadataEntries ||
		tasks > s.config.MaxQueuedTasks || taskBytes > s.config.MaxTaskBytes {
		t.Fatal("state exceeds configured resource bounds")
	}
}

func TestCapabilitiesRestartAndClose(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()
	must(t, operational.ValidateOperationalServices(s.Capabilities(), s.OperationalServices(), operational.Requirements{
		SingleProcess: true, AllowVolatile: true, OAuth: true, Collection: true,
	}))
	if err := operational.ValidateOperationalServices(s.Capabilities(), s.OperationalServices(), operational.Requirements{OAuth: true}); err == nil {
		t.Fatal("process ownership must be explicit")
	}
	must(t, s.PutSession(ctx, "session", "sealed", time.Hour))
	must(t, s.QueueRevocation(ctx, "retry", "encrypted", "opaque:"))
	must(t, s.SetOperationalState(ctx, "checkpoint", []byte("checkpoint")))
	_, err := s.AddMembers(ctx, "enrollment", "owner/repo")
	must(t, err)
	_, err = s.RememberDelivery(ctx, "delivery", time.Hour)
	must(t, err)
	_, err = s.EnqueueUniqueTask(ctx, "tasks", "run:1", 0, operational.TaskFields{Task: "task"})
	must(t, err)
	_, _, _, err = s.ObserveGitHubQuota(ctx, "core", operational.GitHubQuotaObservation{Limit: 10, Remaining: 10, ResetAt: clock.Now().Add(time.Hour)}, "")
	must(t, err)
	health, err := s.Health(ctx)
	must(t, err)
	if !health.Ready || health.Entries == 0 || health.Capabilities.Collection.Scope != operational.ScopeProcess {
		t.Fatalf("health = %#v", health)
	}
	fresh, _ := fixture(t, Config{})
	v, err := fresh.SessionRecord(ctx, "session")
	must(t, err)
	if v != "" {
		t.Fatal("new instance retained a session")
	}
	r, err := fresh.PendingRevocation(ctx, "opaque:")
	must(t, err)
	if r != (operational.Revocation{}) {
		t.Fatal("new instance retained revocations")
	}
	if depth, _ := fresh.QueueStats(ctx, "tasks", ""); depth.Length != 0 {
		t.Fatal("new instance retained tasks")
	}
	if n, _ := fresh.MemberCount(ctx, "enrollment"); n != 0 {
		t.Fatal("new instance retained metadata")
	}
	if st, _ := fresh.GitHubQuotaSnapshot(ctx, "core"); st.Known {
		t.Fatal("new instance retained quota")
	}
	invariant(t, s)
	must(t, s.Close())
	must(t, s.Close())
	_, err = s.SessionRecord(ctx, "session")
	wantError(t, err, operational.ErrUnavailable)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.SessionRecord(canceled, "")
	wantError(t, err, context.Canceled)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions != nil || s.revocations != nil || s.cache != nil || s.records != nil {
		t.Fatal("Close retained state")
	}
}

func TestContextFirstAndConfigValidation(t *testing.T) {
	for _, config := range []Config{
		{MaxCacheEntries: -1}, {MaxCacheBytes: -1}, {MaxProtectedEntries: -1},
		{MaxMetadataBytes: -1}, {MaxSessions: -1}, {MaxRecordBytes: -1},
		{MaxCacheBytes: 1024, MaxCacheValueBytes: 2048},
	} {
		_, err := New(config)
		wantError(t, err, ErrInvalid)
	}
	s, _ := fixture(t, Config{})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for _, call := range []func() error{
		func() error { return s.PutSession(ctx, "", "", 0) },
		func() error { _, err := s.TakeRateLimitTokens(ctx, "", 0, 0, 0); return err },
		func() error { _, err := s.EnqueueTask(ctx, operational.EnqueueRequest{}); return err },
		func() error { return s.RecordIngestionHealthEvent(ctx, "", "", time.Time{}) },
		func() error { _, _, _, err := s.ReserveGitHubQuota(ctx, "", "", 0, 0, 0); return err },
		func() error { _, _, err := s.CachedQueryResult(ctx, "", 0, 0); return err },
	} {
		wantError(t, call(), context.Canceled)
	}
	wantError(t, s.Ping(nil), ErrInvalid) //nolint:staticcheck // SA1012: intentionally verifies rejection of a nil context.
	invariant(t, s)
}

func TestLimiterSaturationAndWeightedMath(t *testing.T) {
	config := DefaultConfig()
	config.MaxRateLimitSubjects = 1
	s, clock := fixture(t, config)
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.TakeRateLimitToken(t.Context(), "one", 10, time.Second)
			if err != nil {
				t.Error(err)
			} else if r.Allowed {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 10 {
		t.Fatalf("allowed %d, want 10", allowed.Load())
	}
	_, err := s.TakeRateLimitToken(t.Context(), "two", 10, time.Second)
	wantError(t, err, operational.ErrCapacity)
	r, err := s.TakeRateLimitToken(t.Context(), "one", 10, time.Second)
	must(t, err)
	if r.Allowed || r.RetryAfter != 100*time.Millisecond || r.ResetAfter != time.Second {
		t.Fatalf("saturated bucket = %#v", r)
	}
	clock.Add(2 * time.Second)
	must(t, s.Maintain(t.Context()))
	r, err = s.TakeRateLimitTokens(t.Context(), "two", 10, 10*time.Second, 8)
	must(t, err)
	if !r.Allowed || r.Remaining != 2 {
		t.Fatalf("weighted charge = %#v", r)
	}
	r, err = s.TakeRateLimitTokens(t.Context(), "two", 10, 10*time.Second, 3)
	must(t, err)
	if r.Allowed || r.Remaining != 0 || r.RetryAfter != 3*time.Second || r.ResetAfter != 10*time.Second {
		t.Fatalf("denied weighted charge must drain = %#v", r)
	}
	clock.Add(1500 * time.Millisecond)
	r, err = s.TakeRateLimitToken(t.Context(), "two", 10, 10*time.Second)
	must(t, err)
	if !r.Allowed || r.Remaining != 0 || r.ResetAfter != 9500*time.Millisecond {
		t.Fatalf("fractional refill = %#v", r)
	}
	invariant(t, s)
}

func TestLocksExpiryRenewalAndStateCopy(t *testing.T) {
	config := DefaultConfig()
	config.MaxLocks, config.MaxStateEntries = 1, 1
	s, clock := fixture(t, config)
	ctx := t.Context()
	ok, err := s.TryLock(ctx, "lock", "owner", time.Second)
	must(t, err)
	if !ok {
		t.Fatal("lock not acquired")
	}
	if ok, _ := s.TryLock(ctx, "lock", "owner", time.Second); ok {
		t.Fatal("NX lock reacquired")
	}
	if ok, _ := s.RenewLock(ctx, "lock", "wrong", time.Hour); ok {
		t.Fatal("wrong owner renewed lock")
	}
	must(t, s.Unlock(ctx, "lock", "wrong"))
	if held, _ := s.LockHeld(ctx, "lock"); !held {
		t.Fatal("wrong owner removed lock")
	}
	clock.Add(500 * time.Millisecond)
	ok, err = s.RenewLock(ctx, "lock", "owner", time.Second)
	must(t, err)
	if !ok {
		t.Fatal("owner renewal failed")
	}
	clock.Add(time.Second)
	if ok, _ := s.RenewLock(ctx, "lock", "owner", time.Second); ok {
		t.Fatal("expired lock renewed")
	}
	if held, _ := s.LockHeld(ctx, "lock"); held {
		t.Fatal("expired lock held")
	}
	ok, err = s.TryLock(ctx, "new", "other", time.Second)
	must(t, err)
	if !ok {
		t.Fatal("expired lock did not free capacity")
	}
	data := []byte("value")
	must(t, s.SetOperationalState(ctx, "checkpoint", data))
	data[0] = 'X'
	out, err := s.OperationalState(ctx, "checkpoint")
	must(t, err)
	if string(out) != "value" {
		t.Fatal("input not copied")
	}
	out[0] = 'Y'
	out, _ = s.OperationalState(ctx, "checkpoint")
	if string(out) != "value" {
		t.Fatal("output not copied")
	}
	wantError(t, s.SetOperationalState(ctx, "other", data), operational.ErrCapacity)
	must(t, s.Clear(ctx, "checkpoint"))
	must(t, s.SetOperationalState(ctx, "other", data))
	invariant(t, s)
}

func TestMetadataAtomicityScanningAndTransfer(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	n, err := s.AddMembers(ctx, "repos", "b", "a", "b", "c")
	must(t, err)
	if n != 3 {
		t.Fatalf("new members = %d", n)
	}
	n, err = s.AddMembers(ctx, "repos", "d", "")
	wantError(t, err, ErrInvalid)
	if n != 0 {
		t.Fatal("invalid batch partly applied")
	}
	members, next, err := s.ScanMembers(ctx, "repos", "", 2)
	must(t, err)
	if fmt.Sprint(members) != "[a b]" || next != "2" {
		t.Fatalf("page = %v %q", members, next)
	}
	members[0] = "mutated"
	members, next, err = s.ScanMembers(ctx, "repos", next, 2)
	must(t, err)
	if fmt.Sprint(members) != "[c]" || next != "0" {
		t.Fatalf("page = %v %q", members, next)
	}
	if yes, _ := s.HasMember(ctx, "repos", "a"); !yes {
		t.Fatal("returned slice changed membership")
	}
	_, err = s.AddMembers(ctx, "install:1:repos", "a")
	must(t, err)
	must(t, s.WriteAttribute(ctx, "owners", "a", "1"))
	nTransfers, err := s.TransferOwners(ctx, "owners", "install:", ":repos", 2, []string{"a", "a", "b"})
	must(t, err)
	if nTransfers != 1 {
		t.Fatalf("transfers = %d", nTransfers)
	}
	if yes, _ := s.HasMember(ctx, "install:1:repos", "a"); yes {
		t.Fatal("old installation kept membership")
	}
	if owner, _ := s.ReadAttribute(ctx, "owners", "a"); owner != "2" {
		t.Fatalf("owner = %q", owner)
	}
	must(t, s.DeleteAttribute(ctx, "owners", "b"))
	must(t, s.RemoveMembers(ctx, "repos", "b", "missing"))
	must(t, s.Clear(ctx, "repos"))
	if count, _ := s.MemberCount(ctx, "repos"); count != 0 {
		t.Fatal("Clear kept members")
	}
	invariant(t, s)
}

func TestDiagnosticsAllowlistDecayAndCopies(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()
	wantError(t, s.IncrementIngestionCounter(ctx, "arbitrary"), ErrInvalid)
	wantError(t, s.RecordIngestionHealthEvent(ctx, "failure", "raw error", clock.Now()), ErrInvalid)
	must(t, s.IncrementIngestionCounter(ctx, "webhookReceived"))
	must(t, s.IncrementIngestionCounter(ctx, "collectionFailed"))
	must(t, s.RecordIngestionHealthEvent(ctx, "failure", "collection", clock.Now()))
	counters, events, err := s.IngestionHealth(ctx)
	must(t, err)
	if counters["webhookReceived"] != 1 || events["healthRevision"] != "3" || events["lastFailureCode"] != "collection" {
		t.Fatalf("health = %v %v", counters, events)
	}
	counters["webhookReceived"], events["lastFailureCode"] = 999, "changed"
	counters, events, _ = s.IngestionHealth(ctx)
	if counters["webhookReceived"] != 1 || events["lastFailureCode"] != "collection" {
		t.Fatal("health maps aliased")
	}
	clock.Add(time.Minute)
	values, err := s.Loads(ctx, []string{"webhook", "failure", "unknown"}, time.Minute)
	must(t, err)
	if math.Abs(values["webhook"]-0.5) > 1e-9 || values["unknown"] != 0 {
		t.Fatalf("loads = %v", values)
	}
	clock.Add(7 * time.Minute)
	values, err = s.Loads(ctx, []string{"webhook"}, time.Minute)
	must(t, err)
	if values["webhook"] != 0 {
		t.Fatal("reads renewed load TTL")
	}
	invariant(t, s)
}
