package collect

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestWorkerCollectsAndProjects exercises the whole collection loop against
// Redis with a fake GitHub CLI: a queued task is leased, collected, completed,
// and coalesced into one projection that activates a new revision.
func TestWorkerCollectsAndProjects(t *testing.T) {
	store, ctx := integrationStore(t)
	workspace := t.TempDir()
	catalogRoot := filepath.Join(workspace, "catalog")
	if err := os.MkdirAll(filepath.Join(catalogRoot, "activity"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(catalogRoot, "activity", "cao.mjs"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	gh := writeFakeBinary(t, workspace, "gh", "exit 0")
	node := writeFakeBinary(t, workspace, "node", "exit 0")

	lake := Lake{Directory: filepath.Join(workspace, "lake")}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	// Seed the lake with a published snapshot so projection has real evidence
	// to activate; the fake CLI stands in for acquiring it.
	copyTree(t, publishedSnapshot, lake.Directory)

	enrollment := Enrollment{Store: store}
	if err := enrollment.AddRepositories(ctx, 7, []string{"octo/api"}); err != nil {
		t.Fatal(err)
	}
	queue := Queue{Store: store}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, Task{Repository: "octo/api", InstallationID: 7}); err != nil {
		t.Fatal(err)
	}

	revisions := make(chan int64, 1)
	worker := Worker{
		Queue: queue,
		Runner: Runner{
			Lake: lake, CatalogRoot: catalogRoot,
			GitHubBinary: gh, NodeBinary: node,
			Tokens: fakeTokens{token: "installation-token"},
		},
		Projector: Projector{
			Store: store, Lake: lake, Enrollment: enrollment,
			CatalogRoot: catalogRoot, NodeBinary: node,
			DatabaseQueriesPath: databaseQueries,
			MinInterval:         50 * time.Millisecond,
		},
		Consumer:      "test-worker",
		BlockInterval: 50 * time.Millisecond,
		Project:       true,
		OnProjection: func(revision int64) {
			select {
			case revisions <- revision:
			default:
			}
		},
	}
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- worker.Run(runCtx) }()

	select {
	case revision := <-revisions:
		if revision == 0 {
			t.Fatal("expected a non-zero activated revision")
		}
	case <-runCtx.Done():
		t.Fatal("the worker did not project collected evidence")
	}
	cancel()
	<-done

	depth, err := queue.Depth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if depth != 0 {
		t.Fatalf("queue depth = %d, want 0 after the task completed", depth)
	}
	dead, err := queue.DeadLetters(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if dead != 0 {
		t.Fatalf("dead letters = %d, want 0", dead)
	}
	active, err := store.Active(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if active.Revision == 0 {
		t.Fatal("expected collection to activate a canonical generation")
	}
}

// TestWorkerRetriesAFailedCollection proves a failing repository is retried
// and never silently dropped, and that failure does not activate a projection.
func TestWorkerRetriesAFailedCollection(t *testing.T) {
	store, ctx := integrationStore(t)
	workspace := t.TempDir()
	catalogRoot := filepath.Join(workspace, "catalog")
	if err := os.MkdirAll(filepath.Join(catalogRoot, "activity"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(catalogRoot, "activity", "cao.mjs"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	gh := writeFakeBinary(t, workspace, "gh", `echo "rate limited" >&2; exit 1`)
	node := writeFakeBinary(t, workspace, "node", "exit 0")
	lake := Lake{Directory: filepath.Join(workspace, "lake")}
	queue := Queue{Store: store, MaxAttempts: 1}
	if err := queue.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, Task{Repository: "octo/api", InstallationID: 7}); err != nil {
		t.Fatal(err)
	}
	worker := Worker{
		Queue: queue,
		Runner: Runner{
			Lake: lake, CatalogRoot: catalogRoot,
			GitHubBinary: gh, NodeBinary: node,
			Tokens: fakeTokens{token: "installation-token"},
		},
		Projector: Projector{
			Store: store, Lake: lake, Enrollment: Enrollment{Store: store},
			DatabaseQueriesPath: databaseQueries,
			MinInterval:         time.Hour,
		},
		Consumer:      "test-worker",
		BlockInterval: 50 * time.Millisecond,
	}
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- worker.Run(runCtx) }()

	deadline := time.Now().Add(8 * time.Second)
	var dead int64
	for time.Now().Before(deadline) {
		var err error
		if dead, err = queue.DeadLetters(ctx); err != nil {
			t.Fatal(err)
		}
		if dead > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	cancel()
	<-done
	if dead != 1 {
		t.Fatalf("dead letters = %d, want the exhausted task to be retained for inspection", dead)
	}
	pending, err := (Projector{Store: store, Lake: lake}).PendingProjection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending {
		t.Fatal("a failed collection must not request projection")
	}
}
