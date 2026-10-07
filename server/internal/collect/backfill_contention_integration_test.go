package collect

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

func TestBackfillWaitsForConcurrentEnrollmentMutation(t *testing.T) {
	store, parent := integrationStore(t)
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	const token = "synthetic-webhook-enrollment"
	if acquired, err := store.TryLock(ctx, enrollmentMutationLock, token, time.Second); err != nil || !acquired {
		t.Fatalf("hold webhook enrollment lease: %t, %v", acquired, err)
	}
	backfill := Backfill{StateStore: store, Metadata: store, Enrollment: Enrollment{Metadata: store, Leases: store}, Queue: Queue{Tasks: store, Admission: store, Metadata: store, Leases: store, Deliveries: store, Metrics: store},
		Lake: Lake{Directory: t.TempDir()},
		Enumerator: fakeRepositoryEnumerator{
			installations: []githubapp.Installation{{ID: 7}},
			repositories:  map[int64][]githubapp.Repository{7: {{FullName: "octo/api"}}},
		},
		RunEnumerator: &fakeWorkflowRunEnumerator{pages: map[workflowRunPageKey]workflowRunPage{
			{installationID: 7, repository: "octo/api", page: 1}: {},
		}},
	}
	done := make(chan error, 1)
	go func() {
		state, err := backfill.Run(ctx)
		if err == nil && state.Phase != "collecting" {
			err = errors.New("backfill did not complete after enrollment contention")
		}
		done <- err
	}()
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-done:
		t.Fatalf("transient enrollment contention aborted backfill: %v", err)
	case <-timer.C:
	}
	if err := store.Unlock(ctx, enrollmentMutationLock, token); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("backfill failed to resume after the webhook lease was released")
	}
}
