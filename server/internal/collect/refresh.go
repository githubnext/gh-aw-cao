package collect

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubapp"
	"github.com/githubnext/gh-cao/server/internal/githubquota"
)

// RepositoryEnumerator keeps installation discovery paginated and quota-governed.
type RepositoryEnumerator interface {
	WorkflowRunQuotaRefresher
	ListRepositoriesPage(context.Context, int64, int) ([]githubapp.Repository, int, githubquota.ResponseQuota, error)
}

type ScopeRefresher struct {
	Client          RepositoryEnumerator
	Quota           RunQuotaService
	QuotaApp        string
	RepositoryLimit int
}

func (r ScopeRefresher) discover(ctx context.Context, enrollment Enrollment, installationID int64) error {
	if r.Client == nil {
		return errors.New("scope refresh requires a GitHub repository enumerator")
	}
	limit := r.RepositoryLimit
	if limit <= 0 {
		limit = 100_000
	}
	return enrollment.withMutationLock(ctx, func(ctx context.Context) error {
		var repositories []string
		count := 0
		for page := 1; page != 0; {
			reservation, err := reserveCollectionQuota(ctx, r.Quota, r.QuotaApp, installationID, r.Client)
			if err != nil {
				return err
			}
			items, next, response, listErr := r.Client.ListRepositoriesPage(ctx, installationID, page)
			if err := reconcileCollectionQuota(ctx, r.Quota, reservation.Bucket, reservation, response); err != nil {
				return err
			}
			if listErr != nil {
				return listErr
			}
			count += len(items)
			if count > limit {
				return errors.New("installation repository discovery exceeds the configured bound")
			}
			if next != 0 && next <= page {
				return errors.New("repository discovery returned a non-advancing page")
			}
			for _, item := range items {
				if item.Archived {
					continue
				}
				name, err := NormalizeRepository(item.FullName)
				if err != nil {
					return fmt.Errorf("normalize discovered repository: %w", err)
				}
				repositories = append(repositories, name)
			}
			page = next
		}
		// Publish only a complete successful enumeration. A partial page set
		// must never enroll repositories or be interpreted as deletion.
		return enrollment.addRepositories(ctx, installationID, repositories)
	})
}

func (w Worker) processRefresh(ctx context.Context, lease Lease) (err error) {
	ctx, cancel := context.WithTimeout(ctx, min(w.Runner.timeout(), w.repositoryLockTTL()/2))
	defer cancel()
	task := lease.Task
	kind := "workflows"
	if task.Scope != nil {
		kind = string(task.Scope.Kind)
	}
	ctx, finish := startRefreshTelemetry(ctx, "worker", kind)
	recordRefreshQueueAge(ctx, task, kind)
	defer func() {
		outcome := "completed"
		if err != nil {
			outcome = "failed"
		}
		finish(outcome, err)
	}()
	if task.Scope != nil {
		if !isScopeIntent(task.Scope.Kind) {
			return errors.New("unsupported scope refresh kind")
		}
		if task.Scope.Kind == IntentEnroll {
			if err := w.ScopeRefresher.discover(ctx, w.Enrollment, task.InstallationID); err != nil {
				return err
			}
		} else {
			admitter := Admitter{Enrollment: w.Enrollment, Queue: w.Queue}
			if _, err := admitter.admitIntent(ctx, Intent{
				Kind: task.Scope.Kind, InstallationID: task.InstallationID,
				Repositories: task.Scope.Repositories,
			}); err != nil {
				return err
			}
		}
	} else {
		owner, err := w.Enrollment.InstallationFor(ctx, task.Repository)
		if err != nil {
			return err
		}
		if owner == 0 || owner != task.InstallationID {
			return w.Queue.Complete(ctx, lease)
		}
	}
	// Persist the follow-up before acknowledging: a crash cannot lose the
	// inventory refresh after committing scope changes.
	if err := w.Projector.RequestProjection(ctx); err != nil {
		return err
	}
	return w.Queue.Complete(ctx, lease)
}

func (w Worker) processRepositoryLifecycle(ctx context.Context, lease Lease) (err error) {
	ctx, finish := startRefreshTelemetry(ctx, "worker", "repository")
	recordRefreshQueueAge(ctx, lease.Task, "repository")
	defer func() {
		outcome := "completed"
		if err != nil {
			outcome = "failed"
		}
		finish(outcome, err)
	}()
	if w.Projector.Data == nil {
		return errors.New("repository lifecycle update requires Postgres")
	}
	task := lease.Task
	if err := w.Projector.Data.UpdateRepositoryLifecycle(ctx, task.RepositoryID, task.Repository, task.Lifecycle, task.EnqueuedAt); err != nil {
		return err
	}
	if err := w.Projector.RequestProjection(ctx); err != nil {
		return err
	}
	var revision int64
	if w.OnProjection != nil {
		state, err := w.Projector.Data.State(ctx)
		if err != nil {
			return err
		}
		revision = state.Revision
	}
	if err := w.Queue.Complete(ctx, lease); err != nil {
		return err
	}
	if w.OnProjection != nil {
		w.OnProjection(revision)
	}
	return nil
}

func (w Worker) retryRefresh(ctx context.Context, lease Lease, cause error) {
	var unavailable *githubquota.UnavailableError
	if errors.As(cause, &unavailable) {
		lease.Task.NotBefore = unavailable.RetryAt
		if !lease.Task.NotBefore.After(time.Now().UTC()) {
			lease.Task.NotBefore = time.Now().UTC().Add(time.Minute)
		}
		lease.Task.NotBefore = lease.Task.NotBefore.Add(backoff(1))
		if err := w.Queue.Defer(ctx, lease); err != nil {
			workerLog.Printf("quota-delayed refresh scheduling failed")
		}
		return
	}
	if err := w.Queue.Retry(ctx, lease, cause); err != nil {
		workerLog.Printf("refresh retry scheduling failed")
	}
}
