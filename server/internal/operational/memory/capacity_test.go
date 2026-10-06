package memory

import (
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestProtectedByteBudgetDoesNotPartiallyChangeOAuth(t *testing.T) {
	s, _ := fixture(t, Config{MaxProtectedBytes: 512})
	ctx := t.Context()
	value := strings.Repeat("s", 100)
	must(t, s.PutSession(ctx, "one", value, time.Hour))
	must(t, s.PutSession(ctx, "two", value, time.Hour))
	wantError(t, s.PutSession(ctx, "three", value, time.Hour), operational.ErrCapacity)
	ok, err := s.CompareSession(ctx, "one", value, strings.Repeat("s", 300), time.Hour)
	wantError(t, err, operational.ErrCapacity)
	if ok {
		t.Fatal("failed CAS updated session")
	}
	_, err = s.InvalidateSession(ctx, "one", "", strings.Repeat("namespace", 20))
	wantError(t, err, operational.ErrCapacity)
	record, err := s.SessionRecord(ctx, "one")
	must(t, err)
	if record != value {
		t.Fatal("capacity failure modified session")
	}
	staged, err := s.InvalidateSession(ctx, "one", "", "")
	must(t, err)
	if staged != value {
		t.Fatal("atomic transfer incorrectly needed double capacity")
	}
	invariant(t, s)
}

func TestTaskPayloadBudgetDoesNotConsumeAdmissionMarkers(t *testing.T) {
	s, _ := fixture(t, Config{MaxTaskBytes: 256})
	ctx := t.Context()
	r := taskRequest("debounce")
	r.Fields.Task = strings.Repeat("p", 256)
	_, err := s.AdmitDelivery(ctx, operational.DeliveryRequest{EnqueueRequest: r, Delivery: "delivery", DeliveryTTL: time.Hour})
	wantError(t, err, operational.ErrCapacity)
	r.Fields.Task = "small"
	result, err := s.AdmitDelivery(ctx, operational.DeliveryRequest{EnqueueRequest: r, Delivery: "delivery", DeliveryTTL: time.Hour})
	must(t, err)
	if result != operational.DeliveryEnqueued {
		t.Fatal("failed payload admission consumed markers")
	}
	invariant(t, s)
}

func TestLeaseBudgetLeavesCursorAndWorkUntouched(t *testing.T) {
	s, _ := fixture(t, Config{MaxLeases: 1})
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	for range 2 {
		_, err := s.EnqueueTask(ctx, taskRequest(""))
		must(t, err)
	}
	r := readRequest()
	r.Count = 2
	_, err := s.ReadTasks(ctx, r)
	wantError(t, err, operational.ErrCapacity)
	st, err := s.QueueStats(ctx, "tasks", "workers")
	must(t, err)
	if st.Backlog != 2 || st.Pending != 0 {
		t.Fatal("failed read partly leased work")
	}
	r.Count = 1
	messages, err := s.ReadTasks(ctx, r)
	must(t, err)
	if len(messages) != 1 {
		t.Fatal("read cursor consumed by failed lease")
	}
	must(t, s.CompleteTask(ctx, "tasks", "workers", messages[0].ID))
	messages, err = s.ReadTasks(ctx, r)
	must(t, err)
	if len(messages) != 1 {
		t.Fatal("released lease did not free capacity")
	}
	invariant(t, s)
}

func TestPromotionReusesRetiredDelayedNameCapacity(t *testing.T) {
	s, clock := fixture(t, Config{MaxQueueNames: 2})
	ctx := t.Context()
	must(t, s.EnsureQueue(ctx, "tasks", "workers"))
	_, err := s.EnqueueTask(ctx, taskRequest(""))
	must(t, err)
	messages, err := s.ReadTasks(ctx, readRequest())
	must(t, err)
	must(t, s.ReplaceTask(ctx, operational.Replacement{Source: "tasks", Group: "workers", ID: messages[0].ID,
		Destination: "new-ready", Delayed: "delayed", Due: clock.Now().Add(time.Second), Fields: messages[0].Fields}))
	clock.Add(time.Second)
	n, err := s.PromoteTasks(ctx, "delayed", "new-ready", clock.Now(), 1)
	must(t, err)
	if n != 1 {
		t.Fatal("due promotion failed to reuse namespace budget")
	}
	st, _ := s.QueueStats(ctx, "new-ready", "")
	if st.Length != 1 {
		t.Fatal("promoted work was lost")
	}
	invariant(t, s)
}

func TestInvalidRecordsAndEmptyPayloadDistinguishMiss(t *testing.T) {
	s, _ := fixture(t, Config{MaxRecordBytes: 16})
	ctx := t.Context()
	wantError(t, s.PutSession(ctx, "session", strings.Repeat("s", 17), time.Hour), ErrInvalid)
	wantError(t, s.WriteAttribute(ctx, "meta", "field", strings.Repeat("s", 17)), ErrInvalid)
	wantError(t, s.SetOperationalState(ctx, "state", make([]byte, 17)), ErrInvalid)
	_, err := s.EnqueueTask(ctx, operational.EnqueueRequest{Queue: "tasks", Fields: operational.TaskFields{Task: strings.Repeat("s", 17)}})
	wantError(t, err, ErrInvalid)
	must(t, s.SetOperationalState(ctx, "state", nil))
	data, err := s.OperationalState(ctx, "state")
	must(t, err)
	if data == nil || len(data) != 0 {
		t.Fatal("stored empty state is indistinguishable from a miss")
	}
	ok, _, err := s.CacheQueryResult(ctx, digest("empty"), nil, 16, 1024)
	must(t, err)
	if !ok {
		t.Fatal("empty cache record rejected")
	}
	data, _, err = s.CachedQueryResult(ctx, digest("empty"), 16, 1024)
	must(t, err)
	if data == nil || len(data) != 0 {
		t.Fatal("stored empty cache record is indistinguishable from a miss")
	}
	invariant(t, s)
}
