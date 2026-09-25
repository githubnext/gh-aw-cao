package collect

import (
	"context"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var recoveryLog = logger.New("cao:collect:recovery")

const deliveryCursorKey = "collect:delivery-cursor"

// DeliveryReplayer recovers missed events by asking GitHub to redeliver App
// webhook deliveries.
//
// This is the gap-recovery path. Scheduled sweeps of the enrollment set are
// not used as a routine backstop: polling 100 000 repositories to find the
// events already recorded in a delivery list costs orders of magnitude more
// requests.
type DeliveryReplayer struct {
	Store   *redisx.Store
	Client  DeliveryClient
	Enabled bool
	// Limit bounds how many deliveries one recovery pass inspects.
	Limit int
}

// DeliveryClient is the App-level delivery API used for recovery.
type DeliveryClient interface {
	ListDeliveries(ctx context.Context, cursor string, limit int) ([]githubapp.Delivery, string, error)
	Redeliver(ctx context.Context, deliveryID int64) error
}

// Result summarizes one recovery pass.
type ReplayResult struct {
	Inspected   int `json:"inspected"`
	Redelivered int `json:"redelivered"`
}

// Recover requests redelivery of failed deliveries newer than the recorded
// cursor. Redelivered events flow through ordinary admission, including
// signature verification and deduplication, so replay is safe to repeat.
func (r DeliveryReplayer) Recover(ctx context.Context) (ReplayResult, error) {
	if !r.Enabled || r.Client == nil {
		return ReplayResult{}, nil
	}
	limit := r.Limit
	if limit <= 0 {
		limit = 200
	}
	deliveries, _, err := r.Client.ListDeliveries(ctx, "", limit)
	if err != nil {
		return ReplayResult{}, err
	}
	lastSeen, err := r.Store.OperationalState(ctx, deliveryCursorKey)
	if err != nil {
		return ReplayResult{}, err
	}
	boundary := string(lastSeen)
	result := ReplayResult{}
	var newest string
	for _, delivery := range deliveries {
		if newest == "" {
			newest = delivery.GUID
		}
		if boundary != "" && delivery.GUID == boundary {
			break
		}
		result.Inspected++
		if delivery.StatusCode >= 200 && delivery.StatusCode < 300 {
			continue
		}
		if err := r.Client.Redeliver(ctx, delivery.ID); err != nil {
			recoveryLog.Printf("redelivery request failed delivery=%d", delivery.ID)
			continue
		}
		result.Redelivered++
	}
	if newest != "" {
		if err := r.Store.SetOperationalState(ctx, deliveryCursorKey, []byte(newest)); err != nil {
			return result, err
		}
	}
	recoveryLog.Printf("delivery recovery inspected=%d redelivered=%d", result.Inspected, result.Redelivered)
	return result, nil
}

// Status is the collection status surface.
//
// In the Actions profile the same surface reports that collection is not
// configured and never fails.
type Status struct {
	Configured    bool       `json:"configured"`
	Coverage      Coverage   `json:"coverage"`
	QueueDepth    int64      `json:"queueDepth"`
	PendingTasks  int64      `json:"pendingTasks"`
	DeadLetters   int64      `json:"deadLetters"`
	Backfill      string     `json:"backfill"`
	LastProjected string     `json:"lastProjected,omitempty"`
	RateLimits    []Headroom `json:"rateLimits,omitempty"`
}

// Headroom is one installation's remaining GitHub budget.
type Headroom struct {
	InstallationID int64  `json:"installationId"`
	Remaining      int    `json:"remaining"`
	ParkedUntil    string `json:"parkedUntil,omitempty"`
}

// Reporter builds the collection status snapshot. It never includes tokens,
// secrets, prompts, or payload contents.
type Reporter struct {
	Enrollment Enrollment
	Queue      Queue
	Backfill   Backfill
	Budget     *githubapp.Budget
	Store      *redisx.Store
}

// Snapshot reads current collection status.
func (r Reporter) Snapshot(ctx context.Context) (Status, error) {
	status := Status{Configured: true}
	coverage, err := r.Enrollment.Coverage(ctx)
	if err != nil {
		return status, err
	}
	status.Coverage = coverage
	if status.QueueDepth, err = r.Queue.Depth(ctx); err != nil {
		return status, err
	}
	if status.PendingTasks, err = r.Queue.Pending(ctx); err != nil {
		return status, err
	}
	if status.DeadLetters, err = r.Queue.DeadLetters(ctx); err != nil {
		return status, err
	}
	state, err := r.Backfill.State(ctx)
	if err != nil {
		return status, err
	}
	status.Backfill = state.Phase
	active, err := r.Store.Active(ctx)
	if err == nil && !active.Activated.IsZero() {
		status.LastProjected = active.Activated.UTC().Format(time.RFC3339Nano)
	}
	if r.Budget != nil {
		installations, err := r.Enrollment.Installations(ctx)
		if err != nil {
			return status, err
		}
		for _, installation := range installations {
			remaining, parked, err := r.Budget.Headroom(ctx, installation)
			if err != nil {
				continue
			}
			headroom := Headroom{InstallationID: installation, Remaining: remaining}
			if !parked.IsZero() {
				headroom.ParkedUntil = parked.Format(time.RFC3339Nano)
			}
			status.RateLimits = append(status.RateLimits, headroom)
		}
	}
	return status, nil
}
