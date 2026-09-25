package githubapp

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"time"
)

// Budget governs GitHub API consumption per installation.
//
// GitHub meters App traffic per installation, so budget is tracked per
// installation and shared across workers through Redis. The governor fails
// closed: when the recorded headroom is unknown or below the floor, a worker
// does not start a collection.
type Budget struct {
	Store BudgetStore
	Floor int
	// Cost is the budget one collection is assumed to spend.
	Cost int
}

// BudgetStore is the subset of the Redis store the governor needs. It exists
// so tests can substitute an in-memory implementation without a Redis server.
type BudgetStore interface {
	HashGet(ctx context.Context, key, field string) (string, error)
	HashSet(ctx context.Context, key, field, value string) error
}

const budgetKey = "collect:rate-limit"

// ErrBudgetExhausted reports that an installation has no headroom to spend.
var ErrBudgetExhausted = errors.New("installation rate-limit budget is exhausted")

// ErrInstallationParked reports that an installation is in backoff after a
// Retry-After or secondary rate-limit response.
var ErrInstallationParked = errors.New("installation is parked after a rate-limit response")

type budgetState struct {
	Remaining int
	Reset     time.Time
	ParkedTo  time.Time
}

// Observe records rate-limit headroom reported by GitHub. Every response
// carries authoritative numbers, so observation corrects drift rather than
// relying on local accounting.
func (b Budget) Observe(ctx context.Context, installationID int64, remaining int, reset time.Time) error {
	state, err := b.read(ctx, installationID)
	if err != nil {
		return err
	}
	state.Remaining = remaining
	state.Reset = reset
	return b.write(ctx, installationID, state)
}

// Park places an installation in backoff until the supplied instant, with
// jitter so concurrent workers do not resume in lockstep.
func (b Budget) Park(ctx context.Context, installationID int64, until time.Time) error {
	state, err := b.read(ctx, installationID)
	if err != nil {
		return err
	}
	// #nosec G404 -- jitter only de-synchronizes worker resume; it is not a secret.
	jitter := time.Duration(rand.Int64N(int64(5 * time.Second)))
	state.ParkedTo = until.Add(jitter).UTC()
	return b.write(ctx, installationID, state)
}

// Reserve claims budget for one collection. It returns the reserve to pass to
// the collection subprocess so the subprocess itself stops before exhausting
// the installation.
func (b Budget) Reserve(ctx context.Context, installationID int64) (int, error) {
	state, err := b.read(ctx, installationID)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	if !state.ParkedTo.IsZero() && state.ParkedTo.After(now) {
		return 0, fmt.Errorf("%w until %s", ErrInstallationParked, state.ParkedTo.Format(time.RFC3339))
	}
	if !state.Reset.IsZero() && state.Reset.Before(now) {
		// The window rolled over; headroom is unknown again until the next
		// observation, and the caller is expected to observe before spending.
		state.Remaining = 0
		state.Reset = time.Time{}
	}
	floor := b.Floor
	if floor <= 0 {
		floor = 1000
	}
	cost := b.Cost
	if cost <= 0 {
		cost = 500
	}
	if state.Remaining > 0 && state.Remaining <= floor {
		return 0, fmt.Errorf("%w: %d remaining at floor %d", ErrBudgetExhausted, state.Remaining, floor)
	}
	state.Remaining = max(state.Remaining-cost, 0)
	if err := b.write(ctx, installationID, state); err != nil {
		return 0, err
	}
	return floor, nil
}

// Headroom reports the recorded remaining budget and park expiry for status
// reporting. It performs no accounting of its own.
func (b Budget) Headroom(ctx context.Context, installationID int64) (int, time.Time, error) {
	state, err := b.read(ctx, installationID)
	if err != nil {
		return 0, time.Time{}, err
	}
	return state.Remaining, state.ParkedTo, nil
}

func (b Budget) read(ctx context.Context, installationID int64) (budgetState, error) {
	if b.Store == nil {
		return budgetState{}, errors.New("rate-limit governor requires a store")
	}
	value, err := b.Store.HashGet(ctx, budgetKey, strconv.FormatInt(installationID, 10))
	if err != nil || value == "" {
		return budgetState{}, err
	}
	return parseBudgetState(value), nil
}

func (b Budget) write(ctx context.Context, installationID int64, state budgetState) error {
	return b.Store.HashSet(ctx, budgetKey, strconv.FormatInt(installationID, 10), formatBudgetState(state))
}

func formatBudgetState(state budgetState) string {
	return fmt.Sprintf("%d|%d|%d", state.Remaining, unixOrZero(state.Reset), unixOrZero(state.ParkedTo))
}

func parseBudgetState(value string) budgetState {
	var remaining, reset, parked int64
	if _, err := fmt.Sscanf(value, "%d|%d|%d", &remaining, &reset, &parked); err != nil {
		return budgetState{}
	}
	return budgetState{
		Remaining: int(remaining),
		Reset:     instantOrZero(reset),
		ParkedTo:  instantOrZero(parked),
	}
}

func unixOrZero(instant time.Time) int64 {
	if instant.IsZero() {
		return 0
	}
	return instant.Unix()
}

func instantOrZero(seconds int64) time.Time {
	if seconds == 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0).UTC()
}
