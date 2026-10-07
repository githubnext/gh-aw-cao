package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

type recoveryEnumerator struct {
	installations []githubapp.Installation
	repositories  map[int64][]githubapp.Repository
	fail          map[int64]error
	beforeRead    func()
}

func (e recoveryEnumerator) ListInstallations(context.Context) ([]githubapp.Installation, error) {
	return e.installations, nil
}
func (e recoveryEnumerator) ListRepositories(_ context.Context, id int64) ([]githubapp.Repository, error) {
	if e.beforeRead != nil {
		e.beforeRead()
	}
	return e.repositories[id], e.fail[id]
}

func volatileBackfill(t *testing.T) Backfill {
	t.Helper()
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	return Backfill{StateStore: store, Metadata: store, Enrollment: Enrollment{Metadata: store, Leases: store}, Queue: Queue{Tasks: store, Admission: store, Metadata: store, Leases: store, Deliveries: store, Metrics: store},
		Lake: lake, ReconstructScope: true, ScopeLimit: 100,
	}
}

func retainedRepository(t *testing.T, lake Lake, repository string) string {
	t.Helper()
	path := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix(repository)+"1.jsonl")
	if err := os.WriteFile(path, []byte(`{"request":{"repository":"`+repository+`"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestVolatileScopeRepairsRestartWithdrawals(t *testing.T) {
	b := volatileBackfill(t)
	stalePath := retainedRepository(t, b.Lake, "octo/withdrawn")
	currentPath := retainedRepository(t, b.Lake, "octo/current")
	if err := b.Enrollment.AddRepositories(t.Context(), 1, []string{"octo/transferred"}); err != nil {
		t.Fatal(err)
	}
	b.Enumerator = recoveryEnumerator{
		installations: []githubapp.Installation{{ID: 2}},
		repositories: map[int64][]githubapp.Repository{
			2: {{FullName: "octo/current"}, {FullName: "octo/transferred"}},
		},
	}
	repositories, installations, failures, err := b.reconstructScope(t.Context())
	if err != nil || installations != 1 || failures != 0 || len(repositories) != 2 {
		t.Fatalf("scope reconstruction: %d, %d, %d, %v", len(repositories), installations, failures, err)
	}
	if _, err := os.Stat(stalePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("withdrawn evidence remained: %v", err)
	}
	if _, err := os.Stat(currentPath); err != nil {
		t.Fatalf("current evidence erased: %v", err)
	}
	owner, err := b.Enrollment.InstallationFor(t.Context(), "octo/transferred")
	if err != nil || owner != 2 {
		t.Fatalf("transferred owner: %d, %v", owner, err)
	}
	old, err := b.Enrollment.RepositoriesForInstallation(t.Context(), 1)
	if err != nil || len(old) != 0 {
		t.Fatalf("old installation retained transfer: %v, %v", old, err)
	}
	installationsList, err := b.Enrollment.Installations(t.Context())
	if err != nil || len(installationsList) != 1 || installationsList[0] != 2 {
		t.Fatalf("stale installation retained: %v, %v", installationsList, err)
	}
}

func TestVolatilePartialScopeCannotEraseOrDeclareReady(t *testing.T) {
	b := volatileBackfill(t)
	path := retainedRepository(t, b.Lake, "octo/keep")
	if err := b.Enrollment.AddRepositories(t.Context(), 1, []string{"octo/keep"}); err != nil {
		t.Fatal(err)
	}
	ready := false
	b.ScopeReady = func(context.Context) error { ready = true; return nil }
	b.Enumerator = recoveryEnumerator{
		installations: []githubapp.Installation{{ID: 1}, {ID: 2}},
		repositories:  map[int64][]githubapp.Repository{1: {{FullName: "octo/new"}}},
		fail:          map[int64]error{2: errors.New("GitHub unavailable")},
	}
	state, err := b.Run(t.Context())
	if err == nil || ready || state.Phase == "collecting" {
		t.Fatalf("partial bootstrap claimed success: %#v, %v", state, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("partial evidence erased: %v", err)
	}
	if enrolled, err := b.Enrollment.Enrolled(t.Context(), "octo/keep"); err != nil || !enrolled {
		t.Fatalf("partial scope removed enrollment: %t, %v", enrolled, err)
	}
}

func TestVolatileEnumerationSerializesNewerWithdrawals(t *testing.T) {
	b := volatileBackfill(t)
	entered, proceed := make(chan struct{}), make(chan struct{})
	b.Enumerator = recoveryEnumerator{
		installations: []githubapp.Installation{{ID: 2}},
		repositories:  map[int64][]githubapp.Repository{2: {{FullName: "octo/current"}}},
		beforeRead:    func() { close(entered); <-proceed },
	}
	done := make(chan error, 1)
	go func() { _, _, _, err := b.reconstructScope(t.Context()); done <- err }()
	<-entered
	_, err := b.Enrollment.RemoveRepositories(t.Context(), 2, []string{"octo/current"})
	if !errors.Is(err, ErrEnrollmentMutationBusy) {
		t.Fatalf("withdrawal raced enumeration: %v", err)
	}
	close(proceed)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := b.Enrollment.RemoveRepositories(t.Context(), 2, []string{"octo/current"}); err != nil {
		t.Fatal(err)
	}
	if enrolled, err := b.Enrollment.Enrolled(t.Context(), "octo/current"); err != nil || enrolled {
		t.Fatalf("newer withdrawal undone: %t, %v", enrolled, err)
	}
}

func TestRetainedIdentityDoesNotUseAmbiguousFilenames(t *testing.T) {
	b := volatileBackfill(t)
	path := filepath.Join(b.Lake.ShardDirectory(), "wrong-repository-logs-1.jsonl")
	if err := os.WriteFile(path, []byte(`{"run":{"repository_full_name":"Actual/Repository"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Lake.RetainedRepositories(t.Context(), 10); err == nil {
		t.Fatal("mismatched layout accepted for erasure")
	}
	correctPath := filepath.Join(b.Lake.ShardDirectory(), "actual-repository-logs-1.jsonl")
	if err := os.Rename(path, correctPath); err != nil {
		t.Fatal(err)
	}
	path = correctPath
	names, err := b.Lake.RetainedRepositories(t.Context(), 10)
	if err != nil || len(names) != 1 || names[0] != "actual/repository" {
		t.Fatalf("retained identities: %v, %v", names, err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Lake.RetainedRepositories(t.Context(), 10); err == nil {
		t.Fatal("identity inferred from filename")
	}
}

func TestVolatileScopeRejectsCollidingShardPrefixesBeforeMutation(t *testing.T) {
	b := volatileBackfill(t)
	path := retainedRepository(t, b.Lake, "a-b/c")
	b.Enumerator = recoveryEnumerator{
		installations: []githubapp.Installation{{ID: 1}},
		repositories:  map[int64][]githubapp.Repository{1: {{FullName: "a/b-c"}}},
	}
	if _, _, _, err := b.reconstructScope(t.Context()); err == nil {
		t.Fatal("colliding repository prefixes accepted")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("collision erased retained evidence: %v", err)
	}
	if enrolled, err := b.Enrollment.Enrolled(t.Context(), "a/b-c"); err != nil || enrolled {
		t.Fatalf("failed snapshot mutated enrollment: %t, %v", enrolled, err)
	}
}

func TestVolatileRecoveryRejectsMixedShardIdentity(t *testing.T) {
	b := volatileBackfill(t)
	path := retainedRepository(t, b.Lake, "a-b/c")
	content := []byte("{\"request\":{\"repository\":\"a-b/c\"}}\n{\"request\":{\"repository\":\"a/b-c\"}}\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Lake.RetainedRepositories(t.Context(), 10); err == nil {
		t.Fatal("only the first record's identity was checked")
	}
}

func TestDetectAmbiguousShardPrefixesAcceptsDisjointNames(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	fresh := map[string]int64{"octo/current": 1}
	previous := map[string]struct{}{"octo/withdrawn": {}}
	if err := detectAmbiguousShardPrefixes(lake, fresh, previous); err != nil {
		t.Fatalf("disjoint repository names must not collide: %v", err)
	}
}

func TestDetectAmbiguousShardPrefixesRejectsCollisionAcrossFreshAndPrevious(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	fresh := map[string]int64{"a/b-c": 1}
	previous := map[string]struct{}{"a-b/c": {}}
	if err := detectAmbiguousShardPrefixes(lake, fresh, previous); err == nil {
		t.Fatal("colliding shard prefixes across fresh and previous scope accepted")
	}
}

func TestDetectAmbiguousShardPrefixesRejectsCollisionWithinPrevious(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	previous := map[string]struct{}{"a/b-c": {}, "a-b/c": {}}
	if err := detectAmbiguousShardPrefixes(lake, nil, previous); err == nil {
		t.Fatal("colliding shard prefixes within previous scope accepted")
	}
}

func TestWithdrawnRepositoriesReturnsSortedComplement(t *testing.T) {
	fresh := map[string]int64{"octo/current": 1}
	previous := map[string]struct{}{"octo/current": {}, "octo/zeta": {}, "octo/alpha": {}}
	withdrawn := withdrawnRepositories(fresh, previous)
	if want := []string{"octo/alpha", "octo/zeta"}; !reflect.DeepEqual(withdrawn, want) {
		t.Fatalf("withdrawnRepositories() = %v, want %v", withdrawn, want)
	}
}

func TestWithdrawnRepositoriesEmptyWhenScopeUnchanged(t *testing.T) {
	fresh := map[string]int64{"octo/current": 1}
	previous := map[string]struct{}{"octo/current": {}}
	if withdrawn := withdrawnRepositories(fresh, previous); len(withdrawn) != 0 {
		t.Fatalf("expected no withdrawals, got %v", withdrawn)
	}
}
