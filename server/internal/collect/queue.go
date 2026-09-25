package collect

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var queueLog = logger.New("cao:collect:queue")

const (
	taskStream       = "collect:tasks"
	deadLetterStream = "collect:dead-letters"
	defaultGroup     = "collectors"
)

// Task is one repository's pending collection. Tasks are keyed by repository,
// never by run, so a burst of runs in one repository becomes one collection.
type Task struct {
	Repository     string    `json:"repository"`
	InstallationID int64     `json:"installationId"`
	Reason         string    `json:"reason"`
	EnqueuedAt     time.Time `json:"enqueuedAt"`
	Attempt        int       `json:"attempt"`
	// NotBefore delays a retried task. Redis streams have no delayed
	// delivery, so a worker that leases an early task returns it unchanged.
	NotBefore time.Time `json:"notBefore,omitempty"`
	// Erase requests deletion of the repository's retained evidence instead of
	// collection. An admission-only process has no evidence lake, so
	// withdrawing consent is queued for a worker that does.
	Erase bool `json:"erase,omitempty"`
}

// Lease is a task delivered to one consumer and not yet acknowledged.
type Lease struct {
	Task      Task
	MessageID string
}

// Queue is the durable, debounced collection queue.
//
// Admission enqueues; it never projects. Stream depth is the worker scaling
// signal, and consumer-group claim semantics recover work from a worker that
// stopped mid-task.
type Queue struct {
	Store *redisx.Store
	// Group is the consumer group name; empty selects the default.
	Group string
	// Debounce collapses repeated events for one repository into one task.
	Debounce time.Duration
	// MaxLength bounds the stream so an unattended queue cannot grow without
	// bound.
	MaxLength int64
	// MaxAttempts bounds retries before a task is dead-lettered.
	MaxAttempts int
}

func (q Queue) group() string {
	if q.Group == "" {
		return defaultGroup
	}
	return q.Group
}

func (q Queue) debounce() time.Duration {
	if q.Debounce <= 0 {
		return 90 * time.Second
	}
	return q.Debounce
}

func (q Queue) maxAttempts() int {
	if q.MaxAttempts <= 0 {
		return 5
	}
	return q.MaxAttempts
}

// Ensure creates the consumer group, tolerating an existing one.
func (q Queue) Ensure(ctx context.Context) error {
	return q.Store.StreamEnsureGroup(ctx, taskStream, q.group())
}

// Enqueue appends a task unless one is already pending for the repository.
// It reports whether a new task was appended; a collapsed event is not an
// error, it is the debounce working.
func (q Queue) Enqueue(ctx context.Context, task Task) (bool, error) {
	repository, err := NormalizeRepository(task.Repository)
	if err != nil {
		return false, err
	}
	task.Repository = repository
	if task.EnqueuedAt.IsZero() {
		task.EnqueuedAt = time.Now().UTC()
	}
	// Erasure is never debounced: collapsing it into a nearby collection would
	// silently retain evidence after consent was withdrawn.
	if task.Attempt == 0 && !task.Erase {
		fresh, err := q.Store.MarkOnce(ctx, debounceKey(repository), q.debounce())
		if err != nil {
			return false, err
		}
		if !fresh {
			queueLog.Printf("collapsed duplicate task repository=%s", repository)
			return false, nil
		}
	}
	payload, err := json.Marshal(task)
	if err != nil {
		return false, err
	}
	if _, err := q.Store.StreamAdd(ctx, taskStream, q.MaxLength, map[string]string{
		"repository": repository,
		"task":       string(payload),
	}); err != nil {
		return false, err
	}
	queueLog.Printf("enqueued task repository=%s attempt=%d", repository, task.Attempt)
	return true, nil
}

// Lease reads undelivered tasks for one consumer.
func (q Queue) Lease(ctx context.Context, consumer string, count int, block time.Duration) ([]Lease, error) {
	messages, err := q.Store.StreamRead(ctx, taskStream, q.group(), consumer, count, block)
	if err != nil {
		return nil, err
	}
	return q.leases(ctx, messages), nil
}

// Reclaim takes over tasks abandoned by a consumer that stopped, so a worker
// crash does not strand a repository.
func (q Queue) Reclaim(ctx context.Context, consumer string, minIdle time.Duration, count int) ([]Lease, error) {
	messages, _, err := q.Store.StreamClaim(ctx, taskStream, q.group(), consumer, minIdle, "0-0", count)
	if err != nil {
		return nil, err
	}
	return q.leases(ctx, messages), nil
}

func (q Queue) leases(ctx context.Context, messages []redisx.StreamMessage) []Lease {
	leases := make([]Lease, 0, len(messages))
	for _, message := range messages {
		var task Task
		if err := json.Unmarshal([]byte(message.Fields["task"]), &task); err != nil {
			// An unparseable entry can never succeed; acknowledge it so it does
			// not block the group, and record it as a dead letter.
			_ = q.Store.StreamAck(ctx, taskStream, q.group(), message.ID)
			_ = q.deadLetter(ctx, Task{Repository: message.Fields["repository"]}, "unparseable task entry")
			continue
		}
		leases = append(leases, Lease{Task: task, MessageID: message.ID})
	}
	return leases
}

// Admit clears the debounce marker so events arriving during collection
// enqueue a follow-up task rather than being silently collapsed into a
// collection that already started.
func (q Queue) Admit(ctx context.Context, task Task) error {
	return q.Store.Clear(ctx, debounceKey(task.Repository))
}

// Defer returns a task that is not yet due, without counting an attempt.
func (q Queue) Defer(ctx context.Context, lease Lease) error {
	if err := q.Store.StreamAck(ctx, taskStream, q.group(), lease.MessageID); err != nil {
		return err
	}
	task := lease.Task
	task.Attempt = max(task.Attempt, 1)
	_, err := q.Enqueue(ctx, task)
	return err
}

// Complete acknowledges a finished task.
func (q Queue) Complete(ctx context.Context, lease Lease) error {
	return q.Store.StreamAck(ctx, taskStream, q.group(), lease.MessageID)
}

// Retry acknowledges a failed task and re-enqueues it with bounded attempts
// and jittered backoff, dead-lettering it when the attempts are exhausted. A
// failed task never partially replaces a repository's existing evidence.
func (q Queue) Retry(ctx context.Context, lease Lease, cause error) error {
	if err := q.Store.StreamAck(ctx, taskStream, q.group(), lease.MessageID); err != nil {
		return err
	}
	task := lease.Task
	task.Attempt++
	if task.Attempt >= q.maxAttempts() {
		reason := "unknown failure"
		if cause != nil {
			reason = cause.Error()
		}
		queueLog.Printf("dead-lettering task repository=%s attempts=%d", task.Repository, task.Attempt)
		return q.deadLetter(ctx, task, reason)
	}
	task.NotBefore = time.Now().UTC().Add(backoff(task.Attempt))
	_, err := q.Enqueue(ctx, task)
	return err
}

// RequeueBlocked returns a task to the queue without counting an attempt. It
// is used when another worker holds the repository lease, so per-repository
// exclusion never consumes the retry budget.
func (q Queue) RequeueBlocked(ctx context.Context, lease Lease) error {
	if err := q.Store.StreamAck(ctx, taskStream, q.group(), lease.MessageID); err != nil {
		return err
	}
	task := lease.Task
	task.Attempt = max(task.Attempt, 1)
	_, err := q.Enqueue(ctx, task)
	return err
}

func (q Queue) deadLetter(ctx context.Context, task Task, reason string) error {
	payload, err := json.Marshal(task)
	if err != nil {
		return err
	}
	_, err = q.Store.StreamAdd(ctx, deadLetterStream, q.MaxLength, map[string]string{
		"repository": task.Repository,
		"task":       string(payload),
		"reason":     reason,
		"recordedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	return err
}

// Depth reports stream depth, the direct scaling signal for workers.
func (q Queue) Depth(ctx context.Context) (int64, error) {
	return q.Store.StreamBacklog(ctx, taskStream, q.group())
}

// Pending reports delivered but unacknowledged tasks, which is processing lag.
func (q Queue) Pending(ctx context.Context) (int64, error) {
	return q.Store.StreamPending(ctx, taskStream, q.group())
}

// DeadLetters reports how many tasks exhausted their retries.
func (q Queue) DeadLetters(ctx context.Context) (int64, error) {
	return q.Store.StreamLength(ctx, deadLetterStream)
}

// ErrRepositoryBusy reports that another worker holds a repository's lease.
var ErrRepositoryBusy = errors.New("repository collection is already running")

// LockRepository takes the per-repository lease. Exclusion is per repository,
// so unrelated repositories proceed in parallel.
func (q Queue) LockRepository(ctx context.Context, repository, token string, ttl time.Duration) error {
	acquired, err := q.Store.TryLock(ctx, repositoryLockName(repository), token, ttl)
	if err != nil {
		return err
	}
	if !acquired {
		return ErrRepositoryBusy
	}
	return nil
}

// UnlockRepository releases the per-repository lease.
func (q Queue) UnlockRepository(ctx context.Context, repository, token string) error {
	return q.Store.Unlock(ctx, repositoryLockName(repository), token)
}

func repositoryLockName(repository string) string {
	return "collect:repository:" + repository
}

func debounceKey(repository string) string {
	return "collect:debounce:" + repository
}

func backoff(attempt int) time.Duration {
	base := time.Duration(1<<min(attempt, 6)) * time.Second
	// #nosec G404 -- jitter only de-synchronizes retries; it is not a secret.
	jitter := time.Duration(rand.Int64N(int64(base / 2)))
	return base + jitter
}
