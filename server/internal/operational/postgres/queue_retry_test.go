package postgres

import (
	"encoding/json"
	"testing"
	"time"
)

func scheduled(t *testing.T, delayed string, due time.Time, position int64) record {
	t.Helper()
	value, err := json.Marshal(task{Delayed: delayed, Due: due})
	if err != nil {
		t.Fatal(err)
	}
	return record{value: value, position: position}
}

func TestRoundUpMillis(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	cases := []struct {
		name string
		in   time.Time
		want time.Time
	}{
		{"exact", base.Add(7 * time.Millisecond), base.Add(7 * time.Millisecond)},
		{"sub-millisecond rounds up", base.Add(7*time.Millisecond + time.Nanosecond), base.Add(8 * time.Millisecond)},
		{"non-UTC zone normalized", base.In(time.FixedZone("x", 3600)), base},
	}
	for _, c := range cases {
		got := roundUpMillis(c.in)
		if !got.Equal(c.want) || got.Location() != time.UTC {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestSelectDue(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	records := []record{
		scheduled(t, "d", at.Add(-time.Second), 3),
		scheduled(t, "d", at.Add(-2*time.Second), 5),
		scheduled(t, "d", at.Add(-time.Second), 2),
		scheduled(t, "d", at.Add(time.Second), 1),
		scheduled(t, "other", at.Add(-time.Hour), 4),
		scheduled(t, "d", at, 6),
	}
	got, err := selectDue(records, "d", at, 10)
	if err != nil {
		t.Fatal(err)
	}
	positions := make([]int64, 0, len(got))
	for _, d := range got {
		positions = append(positions, d.record.position)
	}
	want := []int64{5, 2, 3, 6}
	if len(positions) != len(want) {
		t.Fatalf("positions %v want %v", positions, want)
	}
	for i := range want {
		if positions[i] != want[i] {
			t.Fatalf("positions %v want %v", positions, want)
		}
	}
	limited, err := selectDue(records, "d", at, 2)
	if err != nil || len(limited) != 2 || limited[0].record.position != 5 {
		t.Fatalf("limited %v err %v", limited, err)
	}
	none, err := selectDue(nil, "d", at, 5)
	if err != nil || len(none) != 0 {
		t.Fatalf("empty: %v %v", none, err)
	}
}

func TestSelectDueRejectsCorruptRecord(t *testing.T) {
	if _, err := selectDue([]record{{value: []byte("{")}}, "d", time.Now(), 1); err == nil {
		t.Fatal("expected decode error")
	}
}
