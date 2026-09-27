package githubapp

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var budgetLog = logger.New("cao:githubapp:budget")

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
	ReserveRateLimit(ctx context.Context, key, field string, floor, cost int, now int64) (int, error)
	ObserveRateLimit(ctx context.Context, key, field string, remaining int, reset int64) error
	ParkRateLimit(ctx context.Context, key, field string, parkedTo int64) error
}

const budgetKey = "collect:rate-limit"

// ErrBudgetExhausted reports that an installation has no headroom to spend.
var ErrBudgetExhausted = errors.New("installation rate-limit budget is exhausted")

// ErrInstallationParked reports that an installation is in backoff after a
// Retry-After or secondary rate-limit response.
var ErrInstallationParked = errors.New("installation is parked after a rate-limit response")

// ErrBudgetUnknown reports that no current GitHub rate-limit observation exists.
var ErrBudgetUnknown = errors.New("installation rate-limit budget is unknown")

type budgetState struct {
	Remaining int
	Reset     time.Time
	ParkedTo  time.Time
}

// Observe records rate-limit headroom reported by GitHub. Every response
// carries authoritative numbers, so observation corrects drift rather than
// relying on local accounting.
func (b Budget) Observe(ctx context.Context, installationID int64, remaining int, reset time.Time) error {
	if b.Store == nil {
		return errors.New("rate-limit governor requires a store")
	}
	return b.Store.ObserveRateLimit(
		ctx, budgetKey, strconv.FormatInt(installationID, 10), remaining, unixOrZero(reset))
}

// Park places an installation in backoff until the supplied instant, with
// jitter so concurrent workers do not resume in lockstep.
func (b Budget) Park(ctx context.Context, installationID int64, until time.Time) error {
	if b.Store == nil {
		return errors.New("rate-limit governor requires a store")
	}
	// #nosec G404 -- jitter only de-synchronizes worker resume; it is not a secret.
	jitter := time.Duration(rand.Int64N(int64(5 * time.Second)))
	return b.Store.ParkRateLimit(
		ctx, budgetKey, strconv.FormatInt(installationID, 10), until.Add(jitter).UTC().Unix())
}

// Reserve claims budget for one collection. It returns the reserve to pass to
// the collection subprocess so the subprocess itself stops before exhausting
// the installation.
func (b Budget) Reserve(ctx context.Context, installationID int64) (int, error) {
	if b.Store == nil {
		return 0, errors.New("rate-limit governor requires a store")
	}
	floor := b.Floor
	if floor <= 0 {
		floor = 1000
	}
	cost := b.Cost
	if cost <= 0 {
		cost = 500
	}
	result, err := b.Store.ReserveRateLimit(
		ctx, budgetKey, strconv.FormatInt(installationID, 10), floor, cost, time.Now().UTC().Unix())
	if err != nil {
		return 0, err
	}
	if reserveErr := interpretReservationResult(result); reserveErr != nil {
		budgetLog.Printf("reservation denied result=%d", result)
		return 0, reserveErr
	}
	return floor, nil
}

// interpretReservationResult maps one of BudgetStore.ReserveRateLimit's
// integer result codes to the governor's sentinel errors. It is a pure
// function so the code-to-error mapping is testable without a Redis-backed
// store, and so Reserve's own logic stays limited to orchestrating the call.
func interpretReservationResult(result int) error {
	switch result {
	case 0:
		return nil
	case 1:
		return ErrInstallationParked
	case 2:
		return ErrBudgetExhausted
	case 3:
		return ErrBudgetUnknown
	default:
		return errors.New("rate-limit governor returned an invalid reservation result")
	}
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
