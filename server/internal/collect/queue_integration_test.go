package collect

import (
	"context"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func integrationStore(t *testing.T) (*redisx.Store, context.Context) {
	t.Helper()
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := redisx.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := redisx.NormalizeNamespace("collect-" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	// Each test uses a unique namespace, so leftover keys never cross tests.
	return store, ctx
}

func TestEnrollmentTracksInstallationCoverage(t *testing.T) {
	store, ctx := integrationStore(t)
	enrollment := Enrollment{Store: store}
	if err := enrollment.AddRepositories(ctx, 7, []string{"Octo/API", "octo/web"}); err != nil {
		t.Fatal(err)
	}
	enrolled, err := enrollment.Enrolled(ctx, "octo/api")
	if err != nil {
		t.Fatal(err)
	}
	if !enrolled {
		t.Fatal("expected the repository to be enrolled")
	}
	installation, err := enrollment.InstallationFor(ctx, "octo/api")
	if err != nil {
		t.Fatal(err)
	}
	if installation != 7 {
		t.Fatalf("installation = %d, want 7", installation)
	}
	coverage, err := enrollment.Coverage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if coverage.Repositories != 2 || coverage.Installations != 1 {
		t.Fatalf("unexpected coverage %+v", coverage)
	}
	if _, err := enrollment.RemoveInstallation(ctx, 7); err != nil {
		t.Fatal(err)
	}
	enrolled, err = enrollment.Enrolled(ctx, "octo/api")
	if err != nil {
		t.Fatal(err)
	}
	if enrolled {
		t.Fatal("removing an installation must unenroll its repositories")
	}
}

func TestQueueDebouncesAndLeasesExactlyOnce(t *testing.T) {
	store, ctx := integrationStore(t)
	queue := Queue{Store: store, Debounce: time.Minute}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	task := Task{Repository: "octo/api", InstallationID: 7, Reason: "workflow_run"}
	first, err := queue.Enqueue(ctx, task)
	if err != nil {
		t.Fatal(err)
	}
	second, err := queue.Enqueue(ctx, task)
	if err != nil {
		t.Fatal(err)
	}
	if !first || second {
		t.Fatalf("expected a burst to collapse to one task, got first=%t second=%t", first, second)
	}
	depth, err := queue.Depth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if depth != 1 {
		t.Fatalf("depth = %d, want 1", depth)
	}
	leases, err := queue.Lease(ctx, "worker-a", 10, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 {
		t.Fatalf("leased %d tasks, want 1", len(leases))
	}
	other, err := queue.Lease(ctx, "worker-b", 10, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Fatalf("a leased task must not be delivered twice, got %d", len(other))
	}
	// Admission clears the debounce marker so events arriving during a
	// collection schedule a follow-up instead of being lost.
	if err := queue.Admit(ctx, leases[0].Task); err != nil {
		t.Fatal(err)
	}
	followUp, err := queue.Enqueue(ctx, task)
	if err != nil {
		t.Fatal(err)
	}
	if !followUp {
		t.Fatal("an event during collection must schedule a follow-up")
	}
	if err := queue.Complete(ctx, leases[0]); err != nil {
		t.Fatal(err)
	}
	pending, err := queue.Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending = %d, want 0 after completion", pending)
	}
}

func TestQueueReclaimsAbandonedWork(t *testing.T) {
	store, ctx := integrationStore(t)
	queue := Queue{Store: store}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, Task{Repository: "octo/api", InstallationID: 7}); err != nil {
		t.Fatal(err)
	}
	leases, err := queue.Lease(ctx, "crashed-worker", 10, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 {
		t.Fatalf("leased %d tasks, want 1", len(leases))
	}
	time.Sleep(50 * time.Millisecond)
	reclaimed, err := queue.Reclaim(ctx, "healthy-worker", 10*time.Millisecond, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(reclaimed) != 1 || reclaimed[0].Task.Repository != "octo/api" {
		t.Fatalf("expected the abandoned task to be reclaimed, got %+v", reclaimed)
	}
}

func TestQueueDeadLettersAfterRepeatedFailures(t *testing.T) {
	store, ctx := integrationStore(t)
	queue := Queue{Store: store, MaxAttempts: 2}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, Task{Repository: "octo/api", InstallationID: 7}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("collection failed")
	for attempt := 0; attempt < 3; attempt++ {
		leases, err := queue.Lease(ctx, "worker", 10, 50*time.Millisecond)
		if err != nil {
			t.Fatal(err)
		}
		if len(leases) == 0 {
			break
		}
		if err := queue.Retry(ctx, leases[0], failure); err != nil {
			t.Fatal(err)
		}
	}
	dead, err := queue.DeadLetters(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if dead != 1 {
		t.Fatalf("dead letters = %d, want 1 after exhausting attempts", dead)
	}
}

func TestQueueSerializesOneRepository(t *testing.T) {
	store, ctx := integrationStore(t)
	queue := Queue{Store: store}
	if err := queue.LockRepository(ctx, "octo/api", "token-a", time.Minute); err != nil {
		t.Fatal(err)
	}
	err := queue.LockRepository(ctx, "octo/api", "token-b", time.Minute)
	if !errors.Is(err, ErrRepositoryBusy) {
		t.Fatalf("expected a busy repository, got %v", err)
	}
	if err := queue.UnlockRepository(ctx, "octo/api", "token-a"); err != nil {
		t.Fatal(err)
	}
	if err := queue.LockRepository(ctx, "octo/api", "token-b", time.Minute); err != nil {
		t.Fatalf("expected the lock to be released: %v", err)
	}
}

func TestAdmitterRefusesRepositoriesOutsideScope(t *testing.T) {
	store, ctx := integrationStore(t)
	enrollment := Enrollment{Store: store}
	queue := Queue{Store: store}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	admitter := Admitter{Enrollment: enrollment, Queue: queue}
	payload := []byte(`{"action":"completed","installation":{"id":7},
		"repository":{"full_name":"stranger/repo"}}`)
	if _, err := admitter.Admit(ctx, "workflow_run", payload); !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("expected an unenrolled repository to be refused, got %v", err)
	}
	depth, err := queue.Depth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if depth != 0 {
		t.Fatalf("depth = %d, want 0 for an out-of-scope delivery", depth)
	}
	enroll := []byte(`{"action":"created","installation":{"id":7},
		"repositories":[{"full_name":"octo/api"}]}`)
	if _, err := admitter.Admit(ctx, "installation", enroll); err != nil {
		t.Fatal(err)
	}
	collect := []byte(`{"action":"completed","installation":{"id":7},
		"repository":{"full_name":"octo/api"}}`)
	admission, err := admitter.Admit(ctx, "workflow_run", collect)
	if err != nil {
		t.Fatal(err)
	}
	if !admission.Enqueued || admission.Kind != IntentCollect {
		t.Fatalf("unexpected admission %+v", admission)
	}
}

// Un-enrollment is a withdrawal of consent, so it must erase retained
// evidence rather than merely stop collecting.
func TestAdmitterErasesEvidenceWhenScopeIsWithdrawn(t *testing.T) {
	store, ctx := integrationStore(t)
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	enrollment := Enrollment{Store: store}
	if err := enrollment.AddRepositories(ctx, 11, []string{"acme/kept", "acme/withdrawn"}); err != nil {
		t.Fatal(err)
	}
	projector := Projector{Store: store, Lake: lake, Enrollment: enrollment}
	admitter := Admitter{
		Enrollment: enrollment,
		Queue:      Queue{Store: store},
		Lake:       &lake,
		Projection: projector,
	}
	shards := map[string]string{
		lake.ShardDirectory(): "raw",
		lake.RunsDirectory():  "runs",
	}
	for directory := range shards {
		for _, repository := range []string{"acme/kept", "acme/withdrawn"} {
			name := directory + "/" + lake.ShardPrefix(repository) + "0001.jsonl"
			if err := WriteFileAtomic(name, []byte("{}\n")); err != nil {
				t.Fatal(err)
			}
		}
	}
	payload := []byte(`{"action":"removed","installation":{"id":11},` +
		`"repositories_removed":[{"full_name":"acme/withdrawn"}]}`)
	admission, err := admitter.Admit(ctx, "installation_repositories", payload)
	if err != nil {
		t.Fatal(err)
	}
	if admission.Erased != 1 {
		t.Fatalf("erased %d repositories, want 1", admission.Erased)
	}
	for directory := range shards {
		withdrawn := directory + "/" + lake.ShardPrefix("acme/withdrawn") + "0001.jsonl"
		if _, err := os.Stat(withdrawn); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("withdrawn evidence survived in %s: %v", directory, err)
		}
		kept := directory + "/" + lake.ShardPrefix("acme/kept") + "0001.jsonl"
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("enrolled evidence was erased from %s: %v", directory, err)
		}
	}
	dirty, err := projector.PendingProjection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !dirty {
		t.Fatal("erasure did not request a projection, so the database keeps the rows")
	}
}

// An admission-only process has no evidence lake, so withdrawing consent must
// queue erasure for a worker that does rather than silently retain evidence.
func TestAdmitterQueuesErasureWithoutALake(t *testing.T) {
	store, ctx := integrationStore(t)
	enrollment := Enrollment{Store: store}
	queue := Queue{Store: store}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if err := enrollment.AddRepositories(ctx, 12, []string{"acme/withdrawn"}); err != nil {
		t.Fatal(err)
	}
	admitter := Admitter{Enrollment: enrollment, Queue: queue}
	payload := []byte(`{"action":"deleted","installation":{"id":12}}`)
	if _, err := admitter.Admit(ctx, "installation", payload); err != nil {
		t.Fatal(err)
	}
	leases, err := queue.Lease(ctx, "erasure-test", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 1 {
		t.Fatalf("leased %d tasks, want 1", len(leases))
	}
	if !leases[0].Task.Erase {
		t.Fatal("queued task does not request erasure")
	}
	if leases[0].Task.Repository != "acme/withdrawn" {
		t.Fatalf("queued erasure for %q", leases[0].Task.Repository)
	}
}

func TestTransferredRepositoryIgnoresStaleInstallationRemoval(t *testing.T) {
	store, ctx := integrationStore(t)
	enrollment := Enrollment{Store: store}
	if err := enrollment.AddRepositories(ctx, 11, []string{"octo/api"}); err != nil {
		t.Fatal(err)
	}
	if err := enrollment.AddRepositories(ctx, 12, []string{"octo/api"}); err != nil {
		t.Fatal(err)
	}
	removed, err := enrollment.RemoveInstallation(ctx, 11)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v, want no evidence erasure for the stale installation", removed)
	}
	enrolled, err := enrollment.Enrolled(ctx, "octo/api")
	if err != nil {
		t.Fatal(err)
	}
	if !enrolled {
		t.Fatal("expected the repository to stay enrolled under its current installation")
	}
	installation, err := enrollment.InstallationFor(ctx, "octo/api")
	if err != nil {
		t.Fatal(err)
	}
	if installation != 12 {
		t.Fatalf("installation = %d, want 12", installation)
	}
	removed, err = enrollment.RemoveRepositories(ctx, 12, []string{"octo/api"})
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "octo/api" {
		t.Fatalf("removed = %v, want the repository erased by its current installation", removed)
	}
}
