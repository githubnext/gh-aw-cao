package memory

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func taskRequest(key string) operational.EnqueueRequest {
	return operational.EnqueueRequest{Queue: "tasks", Delayed: "delayed", Debounce: key, DebounceTTL: time.Minute,
		Capacity: 100, Fields: operational.TaskFields{Repository: "owner/repo", Task: `{"attempt":0}`}}
}

func readRequest() operational.QueueRead {
	return operational.QueueRead{Queue: "tasks", Group: "workers", Consumer: "one", Count: 1}
}

func TestConcurrentAtomicDeliveryAdmission(t *testing.T) {
	for _, sameDelivery := range []bool{true, false} {
		t.Run(fmt.Sprint(sameDelivery), func(t *testing.T) {
			s, clock := fixture(t, Config{})
			must(t, s.EnsureQueue(t.Context(), "tasks", "workers"))
			var admitted, duplicate, coalesced atomic.Int64
			var wg sync.WaitGroup
			for i := range 100 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					delivery := "same"
					if !sameDelivery {
						delivery = fmt.Sprint(i)
					}
					result, err := s.AdmitDelivery(t.Context(), operational.DeliveryRequest{
						EnqueueRequest: taskRequest("debounce:owner/repo"), Delivery: delivery, DeliveryTTL: time.Hour,
					})
					if err != nil {
						t.Error(err)
						return
					}
					switch result {
					case operational.DeliveryEnqueued:
						admitted.Add(1)
					case operational.DeliveryCoalesced:
						coalesced.Add(1)
					case operational.DeliveryDuplicate:
						duplicate.Add(1)
					}
				}()
			}
			wg.Wait()
			if admitted.Load() != 1 {
				t.Fatalf("enqueued %d, want 1", admitted.Load())
			}
			if sameDelivery && duplicate.Load() != 99 {
				t.Fatalf("duplicates = %d", duplicate.Load())
			}
			if !sameDelivery && coalesced.Load() != 99 {
				t.Fatalf("coalesced = %d", coalesced.Load())
			}
			stats, err := s.QueueStats(t.Context(), "tasks", "workers")
			must(t, err)
			if stats.Length != 1 || stats.Backlog != 1 || stats.Pending != 0 {
				t.Fatalf("stats = %#v", stats)
			}
			clock.Add(time.Minute)
			ok, err := s.EnqueueTask(t.Context(), taskRequest("debounce:owner/repo"))
			must(t, err)
			if !ok {
				t.Fatal("duplicate admission renewed debounce TTL")
			}
			invariant(t, s)
		})
	}
}

func TestAdmissionCapacityDoesNotConsumeDeliveryOrDebounce(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	request := taskRequest("")
	request.Capacity = 1
	_, err := s.EnqueueTask(ctx, request)
	must(t, err)
	leased, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	request.Debounce = "new-debounce"
	delivery := operational.DeliveryRequest{EnqueueRequest: request, Delivery: "retry-delivery", DeliveryTTL: time.Hour}
	_, err = s.AdmitDelivery(ctx, delivery)
	wantError(t, err, operational.ErrCapacity)
	ok, err := s.RememberDelivery(ctx, "retry-delivery", time.Hour)
	must(t, err)
	if !ok {
		t.Fatal("full queue consumed delivery marker")
	}
	must(t, s.ForgetDelivery(ctx, "retry-delivery"))
	must(t, s.CompleteTask(ctx, "tasks", "workers", leased[0].ID))
	result, err := s.AdmitDelivery(ctx, delivery)
	must(t, err)
	if result != operational.DeliveryEnqueued {
		t.Fatal("failed admission consumed debounce")
	}
	invariant(t, s)
}

func TestMetadataCapacityAdmissionIsAtomic(t *testing.T) {
	config := DefaultConfig()
	config.MaxMetadataEntries = 3
	s, _ := fixture(t, config)
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers")) // Queue and group consume two slots.
	_, err := s.AdmitDelivery(ctx, operational.DeliveryRequest{
		EnqueueRequest: taskRequest("debounce"), Delivery: "delivery", DeliveryTTL: time.Hour,
	})
	wantError(t, err, operational.ErrCapacity)
	stats, _ := s.QueueStats(ctx, "tasks", "workers")
	if stats.Length != 0 {
		t.Fatal("marker failure enqueued work")
	}
	ok, err := s.RememberDelivery(ctx, "delivery", time.Hour)
	must(t, err)
	if !ok {
		t.Fatal("marker failure consumed delivery")
	}
	must(t, s.ForgetDelivery(ctx, "delivery"))
	request := taskRequest("")
	ok, err = s.EnqueueTask(ctx, request)
	must(t, err)
	if !ok {
		t.Fatal("failed transaction consumed capacity")
	}
	invariant(t, s)
}

func TestRetryDelayRecoveryAndStats(t *testing.T) {
	config := DefaultConfig()
	config.MaxQueuedTasks = 2
	s, clock := fixture(t, config)
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	for range 2 {
		_, err := s.EnqueueTask(ctx, taskRequest(""))
		must(t, err)
	}
	leased, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	if len(leased) != 1 {
		t.Fatal("lease count")
	}
	clock.Add(5 * time.Second)
	stats, err := s.QueueStats(ctx, "tasks", "workers")
	must(t, err)
	if stats.Length != 2 || stats.Backlog != 1 || stats.Pending != 1 || stats.OldestPendingAge != 5*time.Second {
		t.Fatalf("lease stats = %#v", stats)
	}
	claimed, err := s.ClaimTasks(ctx, readRequest(), 6*time.Second)
	must(t, err)
	if len(claimed) != 0 {
		t.Fatal("claimed active lease too early")
	}
	r := readRequest()
	r.Consumer = "recovery"
	claimed, err = s.ClaimTasks(ctx, r, 5*time.Second)
	must(t, err)
	if len(claimed) != 1 || claimed[0].ID != leased[0].ID {
		t.Fatal("abandoned task not recovered")
	}
	retry := leased[0].Fields
	retry.Task = `{"attempt":1}`
	due := clock.Now().Add(time.Minute + time.Nanosecond)
	must(t, s.ReplaceTask(ctx, operational.Replacement{Source: "tasks", Group: "workers", ID: leased[0].ID,
		Delayed: "delayed", Due: due, Capacity: 2, Fields: retry}))
	stats, _ = s.QueueStats(ctx, "tasks", "workers")
	depth, _ := s.DelayedDepth(ctx, "delayed")
	if stats.Length != 1 || stats.Pending != 0 || stats.Backlog != 1 || depth != 1 {
		t.Fatalf("delayed stats = %#v depth %d", stats, depth)
	}
	remaining, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	if len(remaining) != 1 || remaining[0].ID == leased[0].ID {
		t.Fatal("delayed work blocked ready work")
	}
	request := taskRequest("")
	request.Capacity = 2
	_, err = s.EnqueueTask(ctx, request)
	wantError(t, err, operational.ErrCapacity)
	must(t, s.CompleteTask(ctx, "tasks", "workers", remaining[0].ID))
	n, err := s.PromoteTasks(ctx, "delayed", "tasks", clock.Now(), 10)
	must(t, err)
	if n != 0 {
		t.Fatal("caller time before due promoted work")
	}
	clock.Add(time.Minute)
	n, err = s.PromoteTasks(ctx, "delayed", "tasks", clock.Now(), 10)
	must(t, err)
	if n != 0 {
		t.Fatal("sub-millisecond due instant rounded down")
	}
	clock.Add(time.Nanosecond)
	n, err = s.PromoteTasks(ctx, "delayed", "tasks", clock.Now(), 10)
	must(t, err)
	if n != 0 {
		t.Fatal("due instant was not rounded up to milliseconds")
	}
	clock.Add(time.Millisecond - time.Nanosecond)
	n, err = s.PromoteTasks(ctx, "delayed", "tasks", clock.Now(), 10)
	must(t, err)
	if n != 1 {
		t.Fatal("due task not promoted")
	}
	messages, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	if len(messages) != 1 || messages[0].ID == leased[0].ID || messages[0].Fields != retry {
		t.Fatal("retry envelope not preserved")
	}
	must(t, s.CompleteTask(ctx, "tasks", "workers", messages[0].ID))
	must(t, s.CompleteTask(ctx, "tasks", "workers", messages[0].ID))
	invariant(t, s)
}

func TestPromotionUsesSuppliedTimeAndReplacementDestination(t *testing.T) {
	for _, advanceClock := range []bool{false, true} {
		t.Run(fmt.Sprint(advanceClock), func(t *testing.T) {
			s, clock := fixture(t, Config{})
			ctx := t.Context()
			must(t, s.EnsureQueue(ctx, "tasks", "workers"))
			_, err := s.EnqueueTask(ctx, taskRequest(""))
			must(t, err)
			messages, err := s.ReadTasks(ctx, readRequest())
			must(t, err)
			due := clock.Now().Add(time.Hour + time.Nanosecond)
			must(t, s.ReplaceTask(ctx, operational.Replacement{
				Source: "tasks", Group: "workers", ID: messages[0].ID,
				Destination: "destination", Delayed: "delayed", Due: due, Fields: messages[0].Fields,
			}))
			if advanceClock {
				clock.Add(3 * time.Hour)
			}
			n, err := s.PromoteTasks(ctx, "delayed", "tasks", due.Add(time.Hour), 1)
			must(t, err)
			if n != 0 {
				t.Fatal("promotion ignored replacement destination")
			}
			n, err = s.PromoteTasks(ctx, "delayed", "destination", due, 1)
			must(t, err)
			if n != 0 {
				t.Fatal("promotion ignored supplied time or rounded due down")
			}
			n, err = s.PromoteTasks(ctx, "delayed", "destination", due.Add(time.Millisecond), 1)
			must(t, err)
			if n != 1 {
				t.Fatal("promotion clamped supplied time to the internal clock")
			}
			must(t, s.EnsureQueue(ctx, "destination", "workers"))
			r := readRequest()
			r.Queue = "destination"
			promoted, err := s.ReadTasks(ctx, r)
			must(t, err)
			if len(promoted) != 1 || promoted[0].Fields != messages[0].Fields {
				t.Fatal("promotion lost destination envelope")
			}
			invariant(t, s)
		})
	}
}

func TestAtomicReplacementCapacityAndMapFreeDeadletter(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	must(t, s.EnsureQueue(ctx, "dead", "workers"))
	_, err := s.EnqueueTask(ctx, taskRequest(""))
	must(t, err)
	_, err = s.EnqueueTask(ctx, operational.EnqueueRequest{Queue: "dead", Fields: operational.TaskFields{Task: "existing"}})
	must(t, err)
	source, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	fields := source[0].Fields
	fields.Reason, fields.RecordedAt, fields.Key = "bounded failure", clock.Now().Format(time.RFC3339Nano), "run:identity"
	replacement := operational.Replacement{Source: "tasks", Group: "workers", ID: source[0].ID, Destination: "dead", Capacity: 1, Fields: fields}
	wantError(t, s.ReplaceTask(ctx, replacement), operational.ErrCapacity)
	stats, _ := s.QueueStats(ctx, "tasks", "workers")
	if stats.Pending != 1 || stats.Length != 1 {
		t.Fatal("failed replacement acknowledged source")
	}
	dr := readRequest()
	dr.Queue = "dead"
	dead, err := s.ReadTasks(ctx, dr)
	must(t, err)
	must(t, s.CompleteTask(ctx, "dead", "workers", dead[0].ID))
	must(t, s.ReplaceTask(ctx, replacement))
	must(t, s.ReplaceTask(ctx, replacement)) // Repeated replacement is a no-op.
	dead, err = s.ReadTasks(ctx, dr)
	must(t, err)
	if len(dead) != 1 || dead[0].Fields != fields {
		t.Fatalf("dead-letter envelope = %#v", dead)
	}
	stats, _ = s.QueueStats(ctx, "tasks", "workers")
	if stats.Length != 0 || stats.Pending != 0 {
		t.Fatal("source not completed atomically")
	}
	invariant(t, s)
}

func TestUniqueHistoricalIdentitySurvivesCompletionAndPressure(t *testing.T) {
	config := DefaultConfig()
	config.MaxMetadataEntries = 4
	s, clock := fixture(t, config)
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	fields := operational.TaskFields{Key: "owner/repo:run:attempt", Task: "run"}
	ok, err := s.EnqueueUniqueTask(ctx, "tasks", "run1", 1, fields)
	must(t, err)
	if !ok {
		t.Fatal("unique admission failed")
	}
	messages, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	must(t, s.CompleteTask(ctx, "tasks", "workers", messages[0].ID))
	clock.Add(48 * time.Hour)
	must(t, s.Maintain(ctx))
	must(t, s.Clear(ctx, "tasks"))
	ok, err = s.EnqueueUniqueTask(ctx, "tasks", "run1", 1, fields)
	must(t, err)
	if ok {
		t.Fatal("completed historical identity was lost")
	}
	ok, err = s.EnqueueUniqueTask(ctx, "tasks", "run2", 1, fields)
	must(t, err)
	if !ok {
		t.Fatal("second identity failed")
	}
	messages, err = s.ReadTasks(ctx, readRequest())
	must(t, err)
	must(t, s.CompleteTask(ctx, "tasks", "workers", messages[0].ID))
	_, err = s.EnqueueUniqueTask(ctx, "tasks", "run3", 1, fields)
	wantError(t, err, operational.ErrCapacity)
	stats, _ := s.QueueStats(ctx, "tasks", "workers")
	if stats.Length != 0 {
		t.Fatal("metadata overflow enqueued without identity")
	}
	invariant(t, s)
}

func TestBlockingReadWakesCancelsAndCloses(t *testing.T) {
	s, _ := fixture(t, Config{})
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	r := readRequest()
	r.Block = time.Minute
	result := make(chan []operational.TaskMessage, 1)
	readErr := make(chan error, 1)
	go func() {
		messages, err := s.ReadTasks(ctx, r)
		result <- messages
		readErr <- err
	}()
	_, err := s.EnqueueTask(ctx, taskRequest(""))
	must(t, err)
	select {
	case messages := <-result:
		if len(messages) != 1 {
			t.Fatal("blocking read did not wake")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocking read hung")
	}
	must(t, <-readErr)
	cancelCtx, cancel := context.WithCancel(ctx)
	go func() {
		_, err := s.ReadTasks(cancelCtx, r)
		readErr <- err
	}()
	cancel()
	wantError(t, <-readErr, context.Canceled)
	go func() {
		_, err := s.ReadTasks(ctx, r)
		readErr <- err
	}()
	must(t, s.Close())
	select {
	case err := <-readErr:
		wantError(t, err, operational.ErrUnavailable)
	case <-time.After(5 * time.Second):
		t.Fatal("Close failed to wake blocking reader")
	}
}

func TestDeliveryReservationLifecycle(t *testing.T) {
	s, clock := fixture(t, Config{})
	ctx := t.Context()
	result, err := s.ReserveDelivery(ctx, "one", time.Second)
	must(t, err)
	if result != operational.DeliveryReserved {
		t.Fatal(result)
	}
	result, err = s.ReserveDelivery(ctx, "one", time.Second)
	must(t, err)
	if result != operational.DeliveryInProgress {
		t.Fatal(result)
	}
	must(t, s.ReleaseDeliveryReservation(ctx, "one"))
	result, err = s.ReserveDelivery(ctx, "one", time.Second)
	must(t, err)
	if result != operational.DeliveryReserved {
		t.Fatal(result)
	}
	_, err = s.RememberDelivery(ctx, "one", time.Second)
	must(t, err)
	result, err = s.ReserveDelivery(ctx, "one", time.Second)
	must(t, err)
	if result != operational.DeliveryAlreadyCommitted {
		t.Fatal(result)
	}
	clock.Add(time.Second)
	result, err = s.ReserveDelivery(ctx, "one", time.Second)
	must(t, err)
	if result != operational.DeliveryReserved {
		t.Fatal("expiry did not free delivery")
	}
	invariant(t, s)
}
