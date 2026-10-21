package admission

import (
	"errors"
	"testing"
	"time"
)

func TestCheckUsage(t *testing.T) {
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	used := func(n int64) *int64 { return &n }
	valid := func() Usage {
		return Usage{
			Unit: "ai-credits", ObservedAt: now.Add(-time.Minute),
			WindowStart: now.Add(-time.Hour), WindowEnd: now.Add(time.Hour),
			Used: used(10), Limit: 100,
		}
	}
	tests := []struct {
		name   string
		mutate func(*Usage)
		want   error
	}{
		{"fresh and under budget", func(*Usage) {}, nil},
		{"observation at two minute edge", func(u *Usage) { u.ObservedAt = now.Add(-2 * time.Minute) }, nil},
		{"observation older than two minutes", func(u *Usage) { u.ObservedAt = now.Add(-2*time.Minute - time.Second) }, ErrUnavailable},
		{"observation slightly in future", func(u *Usage) { u.ObservedAt = now.Add(30 * time.Second) }, nil},
		{"observation too far in future", func(u *Usage) { u.ObservedAt = now.Add(31 * time.Second) }, ErrUnavailable},
		{"zero observation", func(u *Usage) { u.ObservedAt = time.Time{} }, ErrUnavailable},
		{"zero window start", func(u *Usage) { u.WindowStart = time.Time{} }, ErrUnavailable},
		{"window not started", func(u *Usage) { u.WindowStart = now.Add(time.Second) }, ErrUnavailable},
		{"window ended", func(u *Usage) { u.WindowEnd = now }, ErrUnavailable},
		{"window longer than a day", func(u *Usage) { u.WindowStart = now.Add(-24 * time.Hour); u.WindowEnd = now.Add(time.Second) }, ErrUnavailable},
		{"observed before window", func(u *Usage) { u.ObservedAt = u.WindowStart.Add(-time.Second) }, ErrUnavailable},
		{"used equals limit", func(u *Usage) { u.Used = used(100) }, ErrDenied},
		{"used above limit", func(u *Usage) { u.Used = used(101) }, ErrDenied},
		{"used just below limit", func(u *Usage) { u.Used = used(99) }, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			usage := valid()
			test.mutate(&usage)
			if err := checkUsage(usage, now); !errors.Is(err, test.want) {
				t.Fatalf("checkUsage() = %v, want %v", err, test.want)
			}
		})
	}
}
