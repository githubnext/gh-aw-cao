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
	// MaxLength applies admission backpressure. Outstanding work is never
	// trimmed to satisfy this limit.
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
	return q.enqueue(ctx, task)
}

// EnqueueDelivery atomically deduplicates a GitHub delivery and durably
// admits its collection task.
func (q Queue) EnqueueDelivery(ctx context.Context, task Task, delivery string, deliveryTTL time.Duration) (bool, bool, error) {
	repository, payload, err := q.prepareTask(task)
	if err != nil {
		return false, false, err
	}
	result, err := q.Store.StreamEnqueueDelivery(
		ctx, delivery, deliveryTTL, taskStream, debounceKey(repository),
		q.debounce(), q.MaxLength, taskFields(repository, payload),
	)
	if err != nil {
		return false, false, err
	}
	return result == redisx.DeliveryEnqueued, result == redisx.DeliveryDuplicate, nil
}

func (q Queue) enqueue(ctx context.Context, task Task) (bool, error) {
	repository, payload, err := q.prepareTask(task)
	if err != nil {
		return false, err
	}
	debounce := ""
	if task.Attempt == 0 && !task.Erase {
		debounce = debounceKey(repository)
	}
	enqueued, err := q.Store.StreamEnqueue(
		ctx, taskStream, debounce, q.debounce(), q.MaxLength,
		taskFields(repository, payload),
	)
	if err != nil {
		return false, err
	}
	if !enqueued {
		queueLog.Printf("collapsed duplicate task repository=%s", repository)
		return false, nil
	}
	queueLog.Printf("enqueued task repository=%s attempt=%d", repository, task.Attempt)
	return true, nil
}

func (q Queue) prepareTask(task Task) (string, []byte, error) {
	repository, err := NormalizeRepository(task.Repository)
	if err != nil {
		return "", nil, err
	}
	task.Repository = repository
	if task.EnqueuedAt.IsZero() {
		task.EnqueuedAt = time.Now().UTC()
	}
	payload, err := json.Marshal(task)
	if err != nil {
		return "", nil, err
	}
	return repository, payload, nil
}

func taskFields(repository string, payload []byte) map[string]string {
	return map[string]string{"repository": repository, "task": string(payload)}
}

// Lease reads undelivered tasks for one consumer.
func (q Queue) Lease(ctx context.Context, consumer string, count int, block time.Duration) ([]Lease, error) {
	messages, err := q.Store.StreamRead(ctx, taskStream, q.group(), consumer, count, block)
	if err != nil {
		return nil, err
	}
	return q.leases(ctx, messages)
}

// Reclaim takes over tasks abandoned by a consumer that stopped, so a worker
// crash does not strand a repository.
func (q Queue) Reclaim(ctx context.Context, consumer string, minIdle time.Duration, count int) ([]Lease, error) {
	messages, _, err := q.Store.StreamClaim(ctx, taskStream, q.group(), consumer, minIdle, "0-0", count)
	if err != nil {
		return nil, err
	}
	leases, err := q.leases(ctx, messages)
	if len(leases) > 0 {
		queueLog.Printf("reclaimed tasks count=%d", len(leases))
	}
	return leases, err
}

func (q Queue) leases(ctx context.Context, messages []redisx.StreamMessage) ([]Lease, error) {
	leases := make([]Lease, 0, len(messages))
	for _, message := range messages {
		var task Task
		if err := json.Unmarshal([]byte(message.Fields["task"]), &task); err != nil {
			if err := q.deadLetterLease(ctx, message.ID, Task{Repository: message.Fields["repository"]}, "unparseable task entry"); err != nil {
				return leases, err
			}
			continue
		}
		leases = append(leases, Lease{Task: task, MessageID: message.ID})
	}
	return leases, nil
}

// Admit clears the debounce marker so events arriving during collection
// enqueue a follow-up task rather than being silently collapsed into a
// collection that already started.
func (q Queue) Admit(ctx context.Context, task Task) error {
	return q.Store.Clear(ctx, debounceKey(task.Repository))
}

// Defer returns a task that is not yet due, without counting an attempt.
func (q Queue) Defer(ctx context.Context, lease Lease) error {
	task := lease.Task
	task.Attempt = max(task.Attempt, 1)
	return q.replace(ctx, lease.MessageID, task)
}

// Complete acknowledges a finished task.
func (q Queue) Complete(ctx context.Context, lease Lease) error {
	return q.Store.StreamAckAndDelete(ctx, taskStream, q.group(), lease.MessageID)
}

// retryDecision is the pure outcome of applying bounded retry counting to one
// failed task: either rescheduled with a backoff-delayed NotBefore, or
// dead-lettered with a recorded reason once attempts are exhausted.
type retryDecision struct {
	task       Task
	deadLetter bool
	reason     string
}

// decideRetry increments a failed task's attempt count and decides whether it
// is rescheduled or dead-lettered. It is a pure function, so the
// exhausted-attempts boundary and the default dead-letter reason are testable
// without a backing store or the jittered backoff clock.
func decideRetry(task Task, cause error, maxAttempts int, now time.Time, backoffFor func(int) time.Duration) retryDecision {
	task.Attempt++
	if task.Attempt >= maxAttempts {
		reason := "unknown failure"
		if cause != nil {
			reason = cause.Error()
		}
		return retryDecision{task: task, deadLetter: true, reason: reason}
	}
	task.NotBefore = now.Add(backoffFor(task.Attempt))
	return retryDecision{task: task}
}

// Retry acknowledges a failed task and re-enqueues it with bounded attempts
// and jittered backoff, dead-lettering it when the attempts are exhausted. A
// failed task never partially replaces a repository's existing evidence.
func (q Queue) Retry(ctx context.Context, lease Lease, cause error) error {
	decision := decideRetry(lease.Task, cause, q.maxAttempts(), time.Now().UTC(), backoff)
	if decision.deadLetter {
		queueLog.Printf("dead-lettering task repository=%s attempts=%d", decision.task.Repository, decision.task.Attempt)
		return q.deadLetterLease(ctx, lease.MessageID, decision.task, decision.reason)
	}
	queueLog.Printf("rescheduling task repository=%s attempt=%d", decision.task.Repository, decision.task.Attempt)
	return q.replace(ctx, lease.MessageID, decision.task)
}

// RequeueBlocked returns a task to the queue without counting an attempt. It
// is used when another worker holds the repository lease, so per-repository
// exclusion never consumes the retry budget.
func (q Queue) RequeueBlocked(ctx context.Context, lease Lease) error {
	task := lease.Task
	task.Attempt = max(task.Attempt, 1)
	return q.replace(ctx, lease.MessageID, task)
}

func (q Queue) replace(ctx context.Context, messageID string, task Task) error {
	payload, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return q.Store.StreamReplaceAndAck(ctx, taskStream, q.group(), messageID, taskStream, taskFields(task.Repository, payload))
}

func (q Queue) deadLetterLease(ctx context.Context, messageID string, task Task, reason string) error {
	payload, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return q.Store.StreamReplaceAndAck(ctx, taskStream, q.group(), messageID, deadLetterStream, map[string]string{
		"repository": task.Repository,
		"task":       string(payload),
		"reason":     reason,
		"recordedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

// Depth reports stream depth, the direct scaling signal for workers.
func (q Queue) Depth(ctx context.Context) (int64, error) {
	return q.Store.StreamBacklog(ctx, taskStream, q.group())
}

// Pending reports delivered but unacknowledged tasks, which is processing lag.
func (q Queue) Pending(ctx context.Context) (int64, error) {
	return q.Store.StreamPending(ctx, taskStream, q.group())
}

func (q Queue) OldestPendingAge(ctx context.Context) (time.Duration, error) {
	return q.Store.StreamOldestPendingAge(ctx, taskStream, q.group())
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
