package collect

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var queueLog = logger.New("cao:collect:queue")

const (
	taskStream       = "collect:tasks"
	delayedTaskSet   = "collect:delayed-tasks"
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
	// NotBefore delays a retried task in the durable delayed-task set.
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
// Admission enqueues; it never projects. Queue depth reports ready and
// scheduled work, while consumer-group claims recover work from a stopped
// worker.
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
		ctx, delivery, deliveryTTL, taskStream, delayedTaskSet, debounceKey(repository),
		q.debounce(), q.MaxLength, taskFields(repository, payload),
	)
	if err != nil {
		return false, false, err
	}
	switch result {
	case redisx.DeliveryDuplicate:
	case redisx.DeliveryEnqueued:
		_ = q.Store.IncrementIngestionCounter(ctx, "taskQueued")
	case redisx.DeliveryCoalesced:
		_ = q.Store.IncrementIngestionCounter(ctx, "taskCoalesced")
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
		ctx, taskStream, delayedTaskSet, debounce, q.debounce(), q.MaxLength,
		taskFields(repository, payload),
	)
	if err != nil {
		return false, err
	}
	if !enqueued {
		_ = q.Store.IncrementIngestionCounter(ctx, "taskCoalesced")
		queueLog.Printf("collapsed duplicate task repository=%s", repository)
		return false, nil
	}
	_ = q.Store.IncrementIngestionCounter(ctx, "taskQueued")
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
	if _, err := q.promoteDue(ctx, time.Now().UTC(), count); err != nil {
		return nil, err
	}
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
	if err := q.Store.StreamAckAndDelete(ctx, taskStream, q.group(), lease.MessageID); err != nil {
		return err
	}
	_ = q.Store.IncrementIngestionCounter(ctx, "collectionSucceeded")
	_ = q.Store.RecordIngestionHealthEvent(ctx, "success", "", time.Now().UTC())
	return nil
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
	now := time.Now().UTC()
	decision := decideRetry(lease.Task, cause, q.maxAttempts(), now, backoff)
	if decision.deadLetter {
		queueLog.Printf("dead-lettering task repository=%s attempts=%d", decision.task.Repository, decision.task.Attempt)
		if err := q.deadLetterLease(ctx, lease.MessageID, decision.task, decision.reason); err != nil {
			return err
		}
		_ = q.Store.IncrementIngestionCounter(ctx, "collectionFailed")
		_ = q.Store.IncrementIngestionCounter(ctx, "collectionDeadLettered")
		_ = q.Store.RecordIngestionHealthEvent(ctx, "failure", "collection", now)
		return nil
	}
	queueLog.Printf("rescheduling task repository=%s attempt=%d", decision.task.Repository, decision.task.Attempt)
	if err := q.replace(ctx, lease.MessageID, decision.task); err != nil {
		return err
	}
	_ = q.Store.IncrementIngestionCounter(ctx, "collectionFailed")
	_ = q.Store.IncrementIngestionCounter(ctx, "collectionRetried")
	_ = q.Store.RecordIngestionHealthEvent(ctx, "failure", "collection", now)
	return nil
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
	if task.NotBefore.After(time.Now().UTC()) {
		fields := taskFields(task.Repository, payload)
		member, err := scheduledTaskMember(messageID, fields)
		if err != nil {
			return err
		}
		return q.Store.StreamScheduleAndAck(
			ctx, taskStream, q.group(), messageID, delayedTaskSet, dueAtMillis(task.NotBefore), member,
		)
	}
	return q.Store.StreamReplaceAndAck(ctx, taskStream, q.group(), messageID, taskStream, 0, taskFields(task.Repository, payload))
}

type scheduledTask struct {
	ID     string   `json:"id"`
	Fields []string `json:"fields"`
}

func scheduledTaskMember(id string, fields map[string]string) (string, error) {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	orderedFields := make([]string, 0, len(fields))
	for _, name := range names {
		orderedFields = append(orderedFields, name, fields[name])
	}
	payload, err := json.Marshal(scheduledTask{ID: id, Fields: orderedFields})
	return string(payload), err
}

func (q Queue) promoteDue(ctx context.Context, now time.Time, count int) (int64, error) {
	return q.Store.StreamPromoteDue(ctx, delayedTaskSet, taskStream, now.UnixMilli(), count)
}

func dueAtMillis(value time.Time) int64 {
	millis := value.UnixMilli()
	if value.Nanosecond()%int(time.Millisecond) != 0 {
		millis++
	}
	return millis
}

func (q Queue) deadLetterLease(ctx context.Context, messageID string, task Task, reason string) error {
	payload, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return q.Store.StreamReplaceAndAck(ctx, taskStream, q.group(), messageID, deadLetterStream, q.MaxLength, map[string]string{
		"repository": task.Repository,
		"task":       string(payload),
		"reason":     reason,
		"recordedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

// Depth reports ready and scheduled work, excluding already leased tasks.
func (q Queue) Depth(ctx context.Context) (int64, error) {
	backlog, err := q.Store.StreamBacklog(ctx, taskStream, q.group())
	if err != nil {
		return 0, err
	}
	delayed, err := q.Store.SortedSetLength(ctx, delayedTaskSet)
	if err != nil {
		return 0, err
	}
	return backlog + delayed, nil
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
