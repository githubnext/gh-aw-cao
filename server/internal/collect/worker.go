package collect

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var workerLog = logger.New("cao:collect:worker")

// Worker leases collection tasks, collects one repository at a time, and
// requests a coalesced projection.
type Worker struct {
	Queue     Queue
	Runner    Runner
	Projector Projector
	// Consumer identifies this worker within the consumer group.
	Consumer string
	// BatchSize bounds how many tasks are leased at once.
	BatchSize int
	// BlockInterval bounds how long a read waits for new work.
	BlockInterval time.Duration
	// ReclaimAfter is how long a task may be unacknowledged before another
	// worker takes it over.
	ReclaimAfter time.Duration
	// RepositoryLockTTL bounds the per-repository lease.
	RepositoryLockTTL time.Duration
	// Project enables the projection loop on this worker. Every worker may
	// request projection; whichever wins the lease performs it.
	Project bool
	// OnProjection is notified after a successful projection so the server can
	// broadcast the new revision.
	OnProjection func(revision int64)
}

func (w Worker) consumer() string {
	if w.Consumer != "" {
		return w.Consumer
	}
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "worker"
	}
	suffix, err := operationToken()
	if err != nil {
		return host
	}
	return host + "-" + suffix[:8]
}

func (w Worker) batchSize() int {
	if w.BatchSize <= 0 {
		return 4
	}
	return w.BatchSize
}

func (w Worker) blockInterval() time.Duration {
	if w.BlockInterval <= 0 {
		return 5 * time.Second
	}
	return w.BlockInterval
}

func (w Worker) reclaimAfter() time.Duration {
	if w.ReclaimAfter <= 0 {
		return 30 * time.Minute
	}
	return w.ReclaimAfter
}

func (w Worker) repositoryLockTTL() time.Duration {
	if w.RepositoryLockTTL <= 0 {
		return 30 * time.Minute
	}
	return w.RepositoryLockTTL
}

// Run processes tasks until the context is cancelled.
func (w Worker) Run(ctx context.Context) error {
	if err := w.Runner.Validate(); err != nil {
		return err
	}
	if err := w.Queue.Ensure(ctx); err != nil {
		return err
	}
	consumer := w.consumer()
	workerLog.Printf("worker started projection_role=%t", w.Project)
	if w.Project {
		go w.projectionLoop(ctx)
	}
	for ctx.Err() == nil {
		reclaimed, err := w.Queue.Reclaim(ctx, consumer, w.reclaimAfter(), w.batchSize())
		if err != nil {
			workerLog.Printf("task reclaim failed")
		}
		leases := reclaimed
		if len(leases) < w.batchSize() {
			fresh, err := w.Queue.Lease(ctx, consumer, w.batchSize()-len(leases), w.blockInterval())
			if err != nil {
				if ctx.Err() != nil {
					break
				}
				workerLog.Printf("task lease failed")
				sleep(ctx, w.blockInterval())
				continue
			}
			leases = append(leases, fresh...)
		}
		if len(leases) == 0 {
			continue
		}
		collected := false
		for _, lease := range leases {
			if ctx.Err() != nil {
				break
			}
			if w.process(ctx, lease) {
				collected = true
			}
		}
		if collected {
			if err := w.Projector.RequestProjection(ctx); err != nil {
				workerLog.Printf("projection request failed")
			}
		}
	}
	workerLog.Printf("worker stopped")
	return ctx.Err()
}

// process handles one lease and reports whether evidence changed.
func (w Worker) process(ctx context.Context, lease Lease) bool {
	task := lease.Task
	if !task.NotBefore.IsZero() && task.NotBefore.After(time.Now().UTC()) {
		if err := w.Queue.Defer(ctx, lease); err != nil {
			workerLog.Printf("task defer failed")
		}
		return false
	}
	token, err := operationToken()
	if err != nil {
		return false
	}
	if err := w.Queue.LockRepository(ctx, task.Repository, token, w.repositoryLockTTL()); err != nil {
		if errors.Is(err, ErrRepositoryBusy) {
			if err := w.Queue.RequeueBlocked(ctx, lease); err != nil {
				workerLog.Printf("blocked task requeue failed")
			}
			return false
		}
		workerLog.Printf("repository lease failed")
		return false
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = w.Queue.UnlockRepository(release, task.Repository, token)
	}()
	// Clearing the debounce marker before collecting means events that arrive
	// during a collection enqueue a follow-up rather than being collapsed into
	// a collection that already started.
	if err := w.Queue.Admit(ctx, task); err != nil {
		workerLog.Printf("debounce clear failed")
	}
	if task.Erase {
		if err := w.Runner.Lake.Forget(task.Repository); err != nil {
			workerLog.Printf("evidence erasure failed repository=%s", task.Repository)
			if retryErr := w.Queue.Retry(ctx, lease, err); retryErr != nil {
				workerLog.Printf("task retry failed repository=%s", task.Repository)
			}
			return false
		}
		if err := w.Queue.Complete(ctx, lease); err != nil {
			workerLog.Printf("task acknowledgement failed repository=%s", task.Repository)
		}
		workerLog.Printf("erased retained evidence repository=%s", task.Repository)
		return true
	}
	if err := w.Runner.Collect(ctx, task); err != nil {
		workerLog.Printf("collection failed attempt=%d", task.Attempt)
		if retryErr := w.Queue.Retry(ctx, lease, err); retryErr != nil {
			workerLog.Printf("task retry failed")
		}
		return false
	}
	if err := w.Queue.Complete(ctx, lease); err != nil {
		workerLog.Printf("task acknowledgement failed")
	}
	return true
}

// projectionLoop performs coalesced projection. Any worker may run it; the
// global projection lease decides which one actually does.
func (w Worker) projectionLoop(ctx context.Context) {
	interval := w.Projector.minInterval()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pending, err := w.Projector.PendingProjection(ctx)
		if err != nil || !pending {
			continue
		}
		result, err := w.Projector.Project(ctx)
		if err != nil {
			if !errors.Is(err, ErrProjectionBusy) {
				workerLog.Printf("projection failed")
			}
			continue
		}
		if w.OnProjection != nil {
			w.OnProjection(result.Revision)
		}
	}
}

func sleep(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func operationToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
