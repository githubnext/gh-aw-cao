package postgres

import (
	"encoding/json"
	"testing"
	"time"
)

func scheduledRecord(t *testing.T, position int64, delayed string, due time.Time) record {
	t.Helper()
	value, err := json.Marshal(task{Delayed: delayed, Due: due})
	if err != nil {
		t.Fatal(err)
	}
	return record{value: value, position: position}
}

func TestSelectDueTasksOrdersByDueThenPositionAndHonorsLimit(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	records := []record{
		scheduledRecord(t, 3, "retry", base),
		scheduledRecord(t, 1, "retry", base.Add(time.Second)),
		scheduledRecord(t, 2, "retry", base),
		scheduledRecord(t, 4, "other", base.Add(-time.Hour)),
		scheduledRecord(t, 5, "retry", base.Add(time.Hour)),
	}
	got, err := selectDueTasks(records, "retry", base.Add(time.Minute), 10)
	if err != nil {
		t.Fatal(err)
	}
	var positions []int64
	for _, d := range got {
		positions = append(positions, d.record.position)
	}
	if len(positions) != 3 || positions[0] != 2 || positions[1] != 3 || positions[2] != 1 {
		t.Fatalf("positions = %v, want [2 3 1]", positions)
	}
	limited, err := selectDueTasks(records, "retry", base.Add(time.Minute), 2)
	if err != nil || len(limited) != 2 || limited[0].record.position != 2 {
		t.Fatalf("limited = %+v, err = %v", limited, err)
	}
}

func TestSelectDueTasksTruncatesCutoffToMilliseconds(t *testing.T) {
	due := time.Date(2026, 1, 2, 3, 4, 5, 2_000_000, time.UTC)
	records := []record{scheduledRecord(t, 1, "retry", due)}
	got, err := selectDueTasks(records, "retry", due.Add(500*time.Microsecond), 5)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d, err %v; want task due at truncated cutoff", len(got), err)
	}
	got, err = selectDueTasks(records, "retry", due.Add(-time.Millisecond), 5)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %d, err %v; want no early task", len(got), err)
	}
}

func TestSelectDueTasksRejectsUndecodableRecord(t *testing.T) {
	if _, err := selectDueTasks([]record{{value: []byte("not json"), position: 1}}, "retry", time.Now(), 1); err == nil {
		t.Fatal("expected decode error")
	}
}

func TestSelectDueTasksEmptyInput(t *testing.T) {
	got, err := selectDueTasks(nil, "retry", time.Now(), 3)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %d, err %v", len(got), err)
	}
}
