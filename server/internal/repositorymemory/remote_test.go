package repositorymemory

import (
	"context"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

const testOID = "0123456789012345678901234567890123456789"

func TestRemoteResolverCachesCampaignAndContent(t *testing.T) {
	cache := newRemoteCache()
	source := &remoteSource{
		commit: testOID,
		entries: []githubapp.GitTreeEntry{
			{Path: "notes.md", OID: testOID, Mode: "100644", Type: "blob", Size: 5},
			{Path: "ignored.exe", OID: testOID, Mode: "100644", Type: "blob", Size: 1},
			{Path: "link.md", OID: testOID, Mode: "120000", Type: "blob", Size: 5},
		},
		content:  []byte("hello"),
		response: githubapp.APIResponse{Remaining: 100, Reset: time.Now().Add(time.Hour), Truncated: true},
	}
	governor := &remoteGovernor{}
	resolver := newRemoteResolver(cache, source, governor)

	campaign, err := resolver.Campaign(context.Background(), "example")
	if err != nil {
		t.Fatal(err)
	}
	if len(campaign.Files) != 1 || campaign.Files[0].Path != "notes.md" {
		t.Fatalf("unexpected files: %#v", campaign.Files)
	}
	if campaign.Omitted.Extension != 1 ||
		campaign.Omitted.UnsupportedType != 1 ||
		campaign.Omitted.FileLimit != 1 {
		t.Fatalf("unexpected omissions: %#v", campaign.Omitted)
	}
	if _, err := resolver.Campaign(context.Background(), "example"); err != nil {
		t.Fatal(err)
	}
	if source.refCalls != 1 || source.treeCalls != 1 {
		t.Fatalf("campaign was not cached: ref=%d tree=%d", source.refCalls, source.treeCalls)
	}

	content, err := resolver.Content(context.Background(), "example", "notes.md")
	if err != nil || string(content) != "hello" {
		t.Fatalf("unexpected content %q: %v", content, err)
	}
	if _, err := resolver.Content(context.Background(), "example", "notes.md"); err != nil {
		t.Fatal(err)
	}
	if source.blobCalls != 1 {
		t.Fatalf("content was not cached: blob=%d", source.blobCalls)
	}
	if governor.reservations != 3 || governor.observations != 3 {
		t.Fatalf("unexpected governor calls: %#v", governor)
	}
}

func TestRemoteResolverNegativeCachesMissingBranch(t *testing.T) {
	cache := newRemoteCache()
	source := &remoteSource{refErr: githubapp.ErrNotFound}
	resolver := newRemoteResolver(cache, source, &remoteGovernor{})

	for range 2 {
		campaign, err := resolver.Campaign(context.Background(), "missing")
		if err != nil || campaign != nil {
			t.Fatalf("expected missing branch, got %#v: %v", campaign, err)
		}
	}
	if source.refCalls != 1 {
		t.Fatalf("missing branch was not cached: calls=%d", source.refCalls)
	}
}

func TestRemoteResolverReturnsThrottleWithoutCallingGitHub(t *testing.T) {
	cache := newRemoteCache()
	source := &remoteSource{}
	governor := &remoteGovernor{
		reserveErr: githubapp.ErrBudgetExhausted,
		parkedTo:   time.Now().Add(30 * time.Second),
	}
	resolver := newRemoteResolver(cache, source, governor)

	_, err := resolver.Campaign(context.Background(), "example")
	seconds, throttled := RetryAfterSeconds(err)
	if !throttled || seconds < 1 || seconds > 30 {
		t.Fatalf("expected bounded throttle, got %d, %v", seconds, err)
	}
	if source.refCalls != 0 {
		t.Fatal("GitHub was called after the governor rejected the request")
	}
}

func TestRemoteResolverCoalescesConcurrentMiss(t *testing.T) {
	cache := newRemoteCache()
	cache.acquire = false
	resolver := newRemoteResolver(cache, &remoteSource{}, &remoteGovernor{})

	_, err := resolver.Campaign(context.Background(), "example")
	if _, throttled := RetryAfterSeconds(err); !throttled {
		t.Fatalf("expected in-flight miss to be throttled: %v", err)
	}
}

func newRemoteResolver(
	cache *remoteCache, source *remoteSource, governor *remoteGovernor,
) *RemoteResolver {
	return &RemoteResolver{
		Cache: cache,
		Installations: remoteInstallation{
			id: 42,
		},
		Source:            source,
		Governor:          governor,
		ControlRepository: "owner/control",
	}
}

type remoteCache struct {
	campaigns map[string][]byte
	files     map[string][]byte
	acquire   bool
}

func newRemoteCache() *remoteCache {
	return &remoteCache{campaigns: map[string][]byte{}, files: map[string][]byte{}, acquire: true}
}

func (c *remoteCache) CachedRepositoryMemoryCampaign(_ context.Context, campaign string) ([]byte, error) {
	return c.campaigns[campaign], nil
}

func (c *remoteCache) CacheRepositoryMemoryCampaign(
	_ context.Context, campaign string, content []byte, _ time.Duration,
) error {
	c.campaigns[campaign] = append([]byte(nil), content...)
	return nil
}

func (c *remoteCache) CachedRepositoryMemoryFile(
	_ context.Context, campaign, commit, path string,
) ([]byte, error) {
	return c.files[campaign+"\x00"+commit+"\x00"+path], nil
}

func (c *remoteCache) CacheRepositoryMemoryFile(
	_ context.Context, campaign, commit, path string, content []byte, _ time.Duration,
) error {
	c.files[campaign+"\x00"+commit+"\x00"+path] = append([]byte(nil), content...)
	return nil
}

func (c *remoteCache) TryLock(context.Context, string, string, time.Duration) (bool, error) {
	return c.acquire, nil
}

func (*remoteCache) Unlock(context.Context, string, string) error {
	return nil
}

type remoteInstallation struct {
	id int64
}

func (i remoteInstallation) InstallationFor(context.Context, string) (int64, error) {
	return i.id, nil
}

type remoteSource struct {
	commit                         string
	entries                        []githubapp.GitTreeEntry
	content                        []byte
	response                       githubapp.APIResponse
	refErr, treeErr, blobErr       error
	refCalls, treeCalls, blobCalls int
}

func (s *remoteSource) ResolveRef(
	context.Context, int64, string, string,
) (string, githubapp.APIResponse, error) {
	s.refCalls++
	return s.commit, s.response, s.refErr
}

func (s *remoteSource) Tree(
	context.Context, int64, string, string,
) ([]githubapp.GitTreeEntry, githubapp.APIResponse, error) {
	s.treeCalls++
	return s.entries, s.response, s.treeErr
}

func (s *remoteSource) Blob(
	context.Context, int64, string, string,
) ([]byte, githubapp.APIResponse, error) {
	s.blobCalls++
	return s.content, s.response, s.blobErr
}

type remoteGovernor struct {
	reservations int
	observations int
	reserveErr   error
	parkedTo     time.Time
}

func (g *remoteGovernor) Reserve(context.Context, int64) (int, error) {
	g.reservations++
	return 0, g.reserveErr
}

func (g *remoteGovernor) Observe(context.Context, int64, int, time.Time) error {
	g.observations++
	return nil
}

func (g *remoteGovernor) Park(_ context.Context, _ int64, until time.Time) error {
	g.parkedTo = until
	return nil
}

func (g *remoteGovernor) Headroom(context.Context, int64) (int, time.Time, error) {
	return 0, g.parkedTo, nil
}
