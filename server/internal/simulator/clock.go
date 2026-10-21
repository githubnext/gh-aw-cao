package simulator

import (
	"sync"
	"time"
)

// ManualClock advances service time without sleeping or changing HTTP deadlines.
type ManualClock struct {
	mu  sync.Mutex
	now time.Time
}

func NewManualClock(start time.Time) *ManualClock {
	return &ManualClock{now: start.UTC()}
}

func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *ManualClock) Advance(elapsed time.Duration) {
	if elapsed < 0 {
		panic("simulator clock cannot move backwards")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(elapsed)
}
