package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func digest(name string) string {
	h := sha256.Sum256([]byte(name))
	return hex.EncodeToString(h[:])
}

func TestCacheTTLAdmissionCopyAndOldestEviction(t *testing.T) {
	config := DefaultConfig()
	config.MaxCacheEntries = 2
	s, clock := fixture(t, config)
	ctx := t.Context()
	data := []byte("original")
	ok, st, err := s.CacheQueryResult(ctx, digest("one"), data, 1024, 4096)
	must(t, err)
	if !ok || st.Entries != 1 {
		t.Fatalf("admission = %v %#v", ok, st)
	}
	data[0] = 'X'
	out, _, err := s.CachedQueryResult(ctx, digest("one"), 1024, 4096)
	must(t, err)
	if string(out) != "original" {
		t.Fatal("cache did not copy input")
	}
	out[0] = 'Y'
	clock.Add(4 * time.Minute)
	ok, _, err = s.CacheQueryResult(ctx, digest("one"), []byte("replacement"), 1024, 4096)
	must(t, err)
	if !ok {
		t.Fatal("duplicate existing admission failed")
	}
	out, _, _ = s.CachedQueryResult(ctx, digest("one"), 1024, 4096)
	if string(out) != "original" {
		t.Fatal("duplicate admission overwrote data or output aliased")
	}
	clock.Add(time.Minute)
	out, st, err = s.CachedQueryResult(ctx, digest("one"), 1024, 4096)
	must(t, err)
	if out != nil || st.Expired != 1 || st.Entries != 0 {
		t.Fatalf("TTL renewed: %q %#v", out, st)
	}
	for _, key := range []string{"one", "two"} {
		ok, _, err = s.CacheQueryResult(ctx, digest(key), []byte(key), 1024, 4096)
		must(t, err)
		if !ok {
			t.Fatal("admission failed")
		}
	}
	_, _, err = s.CachedQueryResult(ctx, digest("one"), 1024, 4096)
	must(t, err)
	ok, st, err = s.CacheQueryResult(ctx, digest("three"), []byte("three"), 1024, 4096)
	must(t, err)
	if !ok || st.Evicted != 1 || st.Entries != 2 {
		t.Fatalf("eviction = %v %#v", ok, st)
	}
	out, _, _ = s.CachedQueryResult(ctx, digest("one"), 1024, 4096)
	if out != nil {
		t.Fatal("cache hit renewed oldest-entry priority")
	}
	invariant(t, s)
}

func TestCacheAccountingLimitsAndProtectedRecords(t *testing.T) {
	config := DefaultConfig()
	config.MaxCacheBytes, config.MaxCacheValueBytes = 512, 256
	s, _ := fixture(t, config)
	ctx := t.Context()
	must(t, s.PutSession(ctx, "session", "encrypted", time.Hour))
	must(t, s.QueueRevocation(ctx, "retry", "sealed-revocation", ""))
	_, err := s.TryLock(ctx, "lease", "owner", time.Hour)
	must(t, err)
	must(t, s.SetOperationalState(ctx, "checkpoint", []byte("state")))
	ok, _, err := s.CacheQueryResult(ctx, digest("too-big"), make([]byte, 300), 1024, 4096)
	must(t, err)
	if ok {
		t.Fatal("payload limit ignored")
	}
	ok, st, err := s.CacheQueryResult(ctx, digest("accounting"), []byte("fits-payload-only"), 1024, 32)
	must(t, err)
	if ok || st.Entries != 0 {
		t.Fatal("key/accounting bytes not charged")
	}
	for i := range 50 {
		ok, st, err = s.CacheQueryResult(ctx, digest(fmt.Sprint(i)), make([]byte, 128), 1024, 512)
		must(t, err)
		if !ok || st.MemoryBytes > 512 || st.Entries != 1 {
			t.Fatalf("cache bound = %v %#v", ok, st)
		}
	}
	out, st, err := s.CachedQueryResult(ctx, digest("49"), 16, 512)
	must(t, err)
	if out != nil || st.Evicted != 1 {
		t.Fatal("lower read payload bound not enforced")
	}
	if session, _ := s.SessionRecord(ctx, "session"); session != "encrypted" {
		t.Fatal("cache evicted session")
	}
	if pending, _ := s.PendingRevocation(ctx, ""); pending.Value != "sealed-revocation" {
		t.Fatal("cache evicted revocation")
	}
	if held, _ := s.LockHeld(ctx, "lease"); !held {
		t.Fatal("cache evicted lock")
	}
	if state, _ := s.OperationalState(ctx, "checkpoint"); string(state) != "state" {
		t.Fatal("cache evicted state")
	}
	invariant(t, s)
}

func TestDisposableCacheNamespacesTTLAndCopies(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()
	content := []byte(`{"packages":[]}`)
	must(t, s.CacheMarketplaceRegistry(ctx, "registry", "generation", content, time.Second))
	must(t, s.CacheRepositoryMemoryCampaign(ctx, "campaign", []byte("campaign"), time.Second))
	must(t, s.CacheRepositoryMemoryFile(ctx, "campaign", "commit", "path", []byte("file"), time.Second))
	content[0] = 'X'
	value, err := s.CachedMarketplaceRegistry(ctx, "registry", "generation")
	must(t, err)
	if string(value) != `{"packages":[]}` {
		t.Fatal("marketplace input not copied")
	}
	value[0] = 'Y'
	value, _ = s.CachedMarketplaceRegistry(ctx, "registry", "generation")
	if string(value) != `{"packages":[]}` {
		t.Fatal("marketplace output not copied")
	}
	if v, _ := s.CachedMarketplaceRegistry(ctx, "registry", "other"); v != nil {
		t.Fatal("registry generations collided")
	}
	if v, _ := s.CachedRepositoryMemoryFile(ctx, "campaign", "other", "path"); v != nil {
		t.Fatal("repository commits collided")
	}
	wantError(t, s.CacheMarketplaceRegistry(ctx, "registry", "generation", nil, 0), ErrInvalid)
	wantError(t, s.CacheRepositoryMemoryFile(ctx, "campaign", "commit", "path", nil, time.Nanosecond), ErrInvalid)
	clock.Add(time.Second)
	if v, _ := s.CachedMarketplaceRegistry(ctx, "registry", "generation"); v != nil {
		t.Fatal("registry TTL ignored")
	}
	if v, _ := s.CachedRepositoryMemoryCampaign(ctx, "campaign"); v != nil {
		t.Fatal("campaign TTL ignored")
	}
	if v, _ := s.CachedRepositoryMemoryFile(ctx, "campaign", "commit", "path"); v != nil {
		t.Fatal("file TTL ignored")
	}
	health, err := s.Health(ctx)
	must(t, err)
	if health.CacheBytes != 0 {
		t.Fatalf("expired bytes = %d", health.CacheBytes)
	}
	invariant(t, s)
}

func TestQueryCacheFixedEntryCeiling(t *testing.T) {
	config := DefaultConfig()
	config.MaxCacheEntries = operational.QueryCacheMaxEntries + 10
	s, _ := fixture(t, config)
	for i := range operational.QueryCacheMaxEntries + 1 {
		ok, st, err := s.CacheQueryResult(t.Context(), digest(fmt.Sprint(i)), nil, 1024, 1<<20)
		must(t, err)
		if !ok || st.Entries > operational.QueryCacheMaxEntries {
			t.Fatal("fixed query entry ceiling ignored")
		}
	}
	value, st, err := s.CachedQueryResult(t.Context(), digest("0"), 1024, 1<<20)
	must(t, err)
	if value != nil || st.Entries != operational.QueryCacheMaxEntries {
		t.Fatalf("oldest not removed = %#v", st)
	}
	invariant(t, s)
}
