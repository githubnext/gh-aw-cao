package collect

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

type workflowRunPageKey struct {
	installationID int64
	repository     string
	page           int
}

type workflowRunPage struct {
	runs     []githubapp.WorkflowRun
	nextPage int
	err      error
}

type fakeWorkflowRunEnumerator struct {
	pages map[workflowRunPageKey]workflowRunPage
	calls []workflowRunPageKey
}

type fakeRepositoryEnumerator struct {
	installations []githubapp.Installation
	repositories  map[int64][]githubapp.Repository
	failures      map[int64]error
}

func (f fakeRepositoryEnumerator) ListInstallations(context.Context) ([]githubapp.Installation, error) {
	return f.installations, nil
}

func (f fakeRepositoryEnumerator) ListRepositories(
	_ context.Context, installationID int64,
) ([]githubapp.Repository, error) {
	if err := f.failures[installationID]; err != nil {
		return nil, err
	}
	return f.repositories[installationID], nil
}

func (f *fakeWorkflowRunEnumerator) ListWorkflowRuns(
	_ context.Context, installationID int64, repository string, page, perPage int,
) ([]githubapp.WorkflowRun, int, error) {
	if perPage != runBackfillPageSize {
		return nil, 0, errors.New("unexpected workflow run page size")
	}
	key := workflowRunPageKey{installationID: installationID, repository: repository, page: page}
	f.calls = append(f.calls, key)
	result, ok := f.pages[key]
	if !ok {
		return nil, 0, errors.New("unexpected workflow run page")
	}
	return result.runs, result.nextPage, result.err
}

func TestNormalizeEnumeratedRepositoriesCanonicalizesAndCounts(t *testing.T) {
	pushedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	covered := []githubapp.Repository{
		{FullName: "Octo/API", PushedAt: pushedAt},
		{FullName: "octo/tools", PushedAt: pushedAt.Add(time.Hour)},
	}
	names, repositories, skipped := normalizeEnumeratedRepositories(covered)
	if skipped != 0 {
		t.Fatalf("skipped = %d, want 0", skipped)
	}
	if want := []string{"octo/api", "octo/tools"}; !equalStrings(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if len(repositories) != 2 {
		t.Fatalf("len(repositories) = %d, want 2", len(repositories))
	}
	if repositories[0].name != "octo/api" || !repositories[0].pushedAt.Equal(pushedAt) {
		t.Fatalf("repositories[0] = %+v, want name=octo/api pushedAt=%v", repositories[0], pushedAt)
	}
	if repositories[1].name != "octo/tools" || !repositories[1].pushedAt.Equal(pushedAt.Add(time.Hour)) {
		t.Fatalf("repositories[1] = %+v", repositories[1])
	}
}

func TestNormalizeEnumeratedRepositoriesDropsInvalidReferences(t *testing.T) {
	covered := []githubapp.Repository{
		{FullName: "octo/api"},
		{FullName: "not-a-repository"},
		{FullName: ""},
		{FullName: "octo/../escape"},
	}
	names, repositories, skipped := normalizeEnumeratedRepositories(covered)
	if skipped != 3 {
		t.Fatalf("skipped = %d, want 3", skipped)
	}
	if want := []string{"octo/api"}; !equalStrings(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if len(repositories) != 1 || repositories[0].name != "octo/api" {
		t.Fatalf("repositories = %+v", repositories)
	}
}

func TestNormalizeEnumeratedRepositoriesHandlesNoRepositories(t *testing.T) {
	names, repositories, skipped := normalizeEnumeratedRepositories(nil)
	if len(names) != 0 || len(repositories) != 0 || skipped != 0 {
		t.Fatalf("names=%v repositories=%v skipped=%d, want all empty", names, repositories, skipped)
	}
}

func equalStrings(got, want []string) bool {
	return slices.Equal(got, want)
}

func TestSortByRecencyOrdersMostRecentFirst(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	repositories := []enrolledRepository{
		{name: "octo/old", pushedAt: base},
		{name: "octo/newest", pushedAt: base.Add(2 * time.Hour)},
		{name: "octo/mid", pushedAt: base.Add(time.Hour)},
	}
	sortByRecency(repositories)
	want := []string{"octo/newest", "octo/mid", "octo/old"}
	for index, repository := range repositories {
		if repository.name != want[index] {
			t.Fatalf("repositories[%d] = %q, want %q", index, repository.name, want[index])
		}
	}
}

func TestSortByRecencyHandlesEmptyAndSingleton(t *testing.T) {
	empty := []enrolledRepository(nil)
	sortByRecency(empty)
	if len(empty) != 0 {
		t.Fatalf("empty = %v, want empty", empty)
	}
	single := []enrolledRepository{{name: "octo/api"}}
	sortByRecency(single)
	if len(single) != 1 || single[0].name != "octo/api" {
		t.Fatalf("single = %+v", single)
	}
}

func TestEnumerateContinuesAfterInstallationRepositoryFailure(t *testing.T) {
	store, ctx := integrationStore(t)
	backfill := Backfill{
		Enrollment: Enrollment{Store: store},
		Enumerator: fakeRepositoryEnumerator{
			installations: []githubapp.Installation{{ID: 1}, {ID: 2}},
			repositories: map[int64][]githubapp.Repository{
				2: {{FullName: "octo/api"}},
			},
			failures: map[int64]error{1: errors.New("installation unavailable")},
		},
	}
	repositories, installations, failures, err := backfill.enumerate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if installations != 2 || failures != 1 {
		t.Fatalf("installations=%d failures=%d, want 2 and 1", installations, failures)
	}
	if len(repositories) != 1 || repositories[0].name != "octo/api" ||
		repositories[0].installationID != 2 {
		t.Fatalf("repositories=%+v, want octo/api from installation 2", repositories)
	}
}

func TestEnqueueHistoricalRunsPaginatesResumesAndPrioritizesNewRuns(t *testing.T) {
	store, ctx := integrationStore(t)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	run := func(id int64, age int) githubapp.WorkflowRun {
		return githubapp.WorkflowRun{ID: id, Attempt: 1, CreatedAt: base.Add(time.Duration(-age) * time.Hour)}
	}
	failure := errors.New("installation repository API unavailable")
	enumerator := &fakeWorkflowRunEnumerator{pages: map[workflowRunPageKey]workflowRunPage{
		{installationID: 1, repository: "octo/one", page: 1}: {
			runs: []githubapp.WorkflowRun{run(101, 0), run(102, 2)}, nextPage: 2,
		},
		{installationID: 1, repository: "octo/one", page: 2}: {
			runs: []githubapp.WorkflowRun{run(103, 4)},
		},
		{installationID: 2, repository: "octo/two", page: 1}: {
			runs: []githubapp.WorkflowRun{run(201, 1), run(202, 3)},
		},
		{installationID: 3, repository: "octo/three", page: 1}: {err: failure},
	}}
	backfill := Backfill{
		Store: store, Queue: Queue{Store: store, MaxLength: 100}, RunEnumerator: enumerator,
	}
	repositories := []enrolledRepository{
		{name: "octo/one", installationID: 1},
		{name: "octo/two", installationID: 2},
		{name: "octo/three", installationID: 3},
	}

	queued, failures, err := backfill.enqueueHistoricalRuns(ctx, repositories)
	if err != nil {
		t.Fatal(err)
	}
	if queued != 5 || failures != 1 {
		t.Fatalf("queued=%d failures=%d, want queued=5 failures=1", queued, failures)
	}
	if got, err := store.HashGet(ctx, runBackfillCursorKey, "1:octo/one"); err != nil || got != runBackfillComplete {
		t.Fatalf("one cursor=%q err=%v, want complete", got, err)
	}
	if got, err := store.HashGet(ctx, runBackfillCursorKey, "3:octo/three"); err != nil || got != "" {
		t.Fatalf("failed repository cursor=%q err=%v, want unchanged", got, err)
	}

	enumerator.pages[workflowRunPageKey{installationID: 3, repository: "octo/three", page: 1}] =
		workflowRunPage{runs: []githubapp.WorkflowRun{run(301, 5)}}
	queued, failures, err = backfill.enqueueHistoricalRuns(ctx, repositories)
	if err != nil {
		t.Fatal(err)
	}
	if queued != 1 || failures != 0 {
		t.Fatalf("resume queued=%d failures=%d, want queued=1 failures=0", queued, failures)
	}
	if len(enumerator.calls) != 5 {
		t.Fatalf("enumerator calls=%v, want 5 calls with completed repositories skipped", enumerator.calls)
	}

	if err := store.StreamEnsureGroup(ctx, runTaskStream, "run-backfill-test"); err != nil {
		t.Fatal(err)
	}
	messages, err := store.StreamRead(ctx, runTaskStream, "run-backfill-test", "test", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	var gotRunIDs []int64
	for _, message := range messages {
		var task RunTask
		if err := json.Unmarshal([]byte(message.Fields["task"]), &task); err != nil {
			t.Fatal(err)
		}
		gotRunIDs = append(gotRunIDs, task.RunID)
	}
	wantRunIDs := []int64{101, 201, 102, 202, 103, 301}
	if !slices.Equal(gotRunIDs, wantRunIDs) {
		t.Fatalf("run task order=%v, want newest-first %v", gotRunIDs, wantRunIDs)
	}
}

func TestFailedBackfillStateSetsPhaseErrorAndCompletedAt(t *testing.T) {
	state := BackfillState{
		Phase:         "enumerating",
		StartedAt:     "2026-01-01T00:00:00Z",
		Installations: 3,
	}
	cause := errors.New("enumeration failed")
	completedAt := "2026-01-01T00:05:00Z"
	failed := failedBackfillState(state, cause, completedAt)
	if failed.Phase != "failed" {
		t.Fatalf("Phase = %q, want %q", failed.Phase, "failed")
	}
	if failed.Error != cause.Error() {
		t.Fatalf("Error = %q, want %q", failed.Error, cause.Error())
	}
	if failed.CompletedAt != completedAt {
		t.Fatalf("CompletedAt = %q, want %q", failed.CompletedAt, completedAt)
	}
	// Fields unrelated to the failure transition must survive untouched.
	if failed.StartedAt != state.StartedAt || failed.Installations != state.Installations {
		t.Fatalf("failed = %+v, want StartedAt/Installations preserved from %+v", failed, state)
	}
}

func TestFailedBackfillStateOverwritesPriorTerminalFields(t *testing.T) {
	state := BackfillState{Phase: "seeding", Error: "", CompletedAt: ""}
	failed := failedBackfillState(state, errors.New("queue unavailable"), "2026-02-02T00:00:00Z")
	if failed.Phase != "failed" || failed.Error != "queue unavailable" || failed.CompletedAt != "2026-02-02T00:00:00Z" {
		t.Fatalf("failed = %+v", failed)
	}
}
