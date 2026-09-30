package githubquota

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var quotaLog = logger.New("cao:githubquota")

// DefaultReservationTTL bounds how long a reservation holds capacity when a
// worker neither commits nor releases it, for example after a crash.
const DefaultReservationTTL = 10 * time.Minute

// Status classifies a bucket for a worker deciding whether to start work.
type Status string

const (
	// StatusAvailable means the bucket has known quota above the safety reserve.
	StatusAvailable Status = "available"
	// StatusExhausted means the known quota is at or below the safety reserve.
	StatusExhausted Status = "exhausted"
	// StatusParked means the bucket is temporarily unavailable, for example
	// after a Retry-After or secondary rate-limit response.
	StatusParked Status = "parked"
	// StatusUnknown means there is no current authoritative observation.
	StatusUnknown Status = "unknown"
)

var (
	// ErrExhausted reports that a bucket cannot satisfy the requested cost
	// and minimum remaining quota.
	ErrExhausted = errors.New("github quota bucket is exhausted")
	// ErrParked reports that a bucket is temporarily parked.
	ErrParked = errors.New("github quota bucket is parked")
	// ErrUnknown reports that no current authoritative observation exists.
	ErrUnknown = errors.New("github quota bucket is unknown")
	// ErrNoCandidates reports that selection received no buckets.
	ErrNoCandidates = errors.New("github quota selection has no candidate buckets")
)

// UnavailableError describes why a bucket could not admit work. It wraps
// ErrExhausted, ErrParked, or ErrUnknown so callers can use errors.Is.
type UnavailableError struct {
	Bucket BucketID
	Status Status
	// RetryAt is the earliest instant the bucket may admit work again: the
	// parking end for a parked bucket and the reset time for an exhausted
	// bucket. It is zero when unknown.
	RetryAt time.Time
	cause   error
}

func (e *UnavailableError) Error() string {
	return fmt.Sprintf("%s: %s", e.cause.Error(), e.Bucket)
}

func (e *UnavailableError) Unwrap() error {
	return e.cause
}

// Observation is one authoritative rate-limit observation from GitHub
// response metadata.
type Observation struct {
	Limit      int
	Remaining  int
	ResetAt    time.Time
	ObservedAt time.Time
}

// ReservationRequest describes capacity to reserve for one unit of work.
// Admission requires remaining - reserved - EstimatedCost >= MinimumRemain.
type ReservationRequest struct {
	EstimatedCost int
	MinimumRemain int
	// TTL overrides the service's reservation expiry when positive.
	TTL time.Duration
}

// Reservation is capacity promised to work that has not yet been reconciled.
type Reservation struct {
	ID        string
	Bucket    BucketID
	Amount    int
	ExpiresAt time.Time
}

// Requirement describes the capacity a unit of work needs from a bucket.
type Requirement struct {
	EstimatedCost int
	MinimumRemain int
}

// BucketState is an operator-facing view of one bucket.
type BucketState struct {
	Bucket BucketID `json:"bucket"`
	Status Status   `json:"status"`
	// Limit and Remaining are the last authoritative GitHub observation.
	Limit     int `json:"limit"`
	Remaining int `json:"remaining"`
	// Reserved is capacity promised to unreconciled work.
	Reserved int `json:"reserved"`
	// Available is Remaining - Reserved, never negative.
	Available   int       `json:"available"`
	ResetAt     time.Time `json:"resetAt,omitzero"`
	ObservedAt  time.Time `json:"observedAt,omitzero"`
	ParkedUntil time.Time `json:"parkedUntil,omitzero"`
	ParkReason  string    `json:"parkReason,omitempty"`
	// CheckedAt is the shared Redis clock at which the state was read.
	CheckedAt time.Time `json:"checkedAt"`
}

// Store is the atomic persistence the service needs. *redisx.Store
// implements it; tests may substitute an in-memory implementation.
type Store interface {
	GitHubQuotaSnapshot(ctx context.Context, bucket string) (redisx.GitHubQuotaState, error)
	ObserveGitHubQuota(ctx context.Context, bucket string, observation redisx.GitHubQuotaObservation, releaseID string) (redisx.GitHubQuotaObserveOutcome, bool, redisx.GitHubQuotaState, error)
	ReserveGitHubQuota(ctx context.Context, bucket, id string, cost, minimumRemain int64, ttl time.Duration) (redisx.GitHubQuotaAdmission, time.Time, redisx.GitHubQuotaState, error)
	ReleaseGitHubQuota(ctx context.Context, bucket, id string) (bool, redisx.GitHubQuotaState, error)
	ParkGitHubQuota(ctx context.Context, bucket string, until time.Time, reason string) (bool, redisx.GitHubQuotaState, error)
	UnparkGitHubQuota(ctx context.Context, bucket string) (redisx.GitHubQuotaState, error)
}

// Options configures a Service.
type Options struct {
	// ReservationTTL is the default reservation expiry. Zero selects
	// DefaultReservationTTL.
	ReservationTTL time.Duration
	// SafetyReserve is a floor no reservation or selection may cross,
	// regardless of the caller's MinimumRemain.
	SafetyReserve int
}

// Service coordinates GitHub API quota across buckets and replicas.
type Service struct {
	store          Store
	reservationTTL time.Duration
	safetyReserve  int
}

// New constructs a Service over an atomic store.
func New(store Store, options Options) (*Service, error) {
	if store == nil {
		return nil, errors.New("github quota service requires a store")
	}
	if options.ReservationTTL < 0 || options.SafetyReserve < 0 {
		return nil, errors.New("github quota reservation TTL and safety reserve must not be negative")
	}
	ttl := options.ReservationTTL
	if ttl == 0 {
		ttl = DefaultReservationTTL
	}
	return &Service{store: store, reservationTTL: ttl, safetyReserve: options.SafetyReserve}, nil
}

// Observe records an authoritative GitHub observation for a bucket. An
// observation from a newer reset window replaces the recorded window; one
// from the recorded window never increases remaining quota; one from an older
// window is ignored.
func (s *Service) Observe(ctx context.Context, bucket BucketID, observation Observation) error {
	_, err := s.observe(ctx, bucket, observation, "")
	return err
}

// Commit reconciles a reservation with the authoritative observation taken
// after its work ran. The observation is recorded and the reservation removed
// in one atomic step, so the consumed capacity is counted exactly once.
func (s *Service) Commit(ctx context.Context, reservation Reservation, observation Observation) error {
	if reservation.ID == "" {
		return errors.New("github quota commit requires a reservation")
	}
	released, err := s.observe(ctx, reservation.Bucket, observation, reservation.ID)
	if err != nil {
		return err
	}
	if !released {
		quotaLog.Printf("committed reservation had already expired bucket=%s", reservation.Bucket.Normalize())
	}
	return nil
}

func (s *Service) observe(ctx context.Context, bucket BucketID, observation Observation, releaseID string) (bool, error) {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		return false, err
	}
	if observation.Limit < 0 || observation.Remaining < 0 || observation.Remaining > observation.Limit {
		return false, errors.New("github quota observation requires 0 <= remaining <= limit")
	}
	if observation.ResetAt.IsZero() {
		return false, errors.New("github quota observation requires a reset time")
	}
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = time.Now()
	}
	outcome, released, _, err := s.store.ObserveGitHubQuota(ctx, bucket.storageKey(), redisx.GitHubQuotaObservation{
		Limit:      int64(observation.Limit),
		Remaining:  int64(observation.Remaining),
		ResetAt:    observation.ResetAt,
		ObservedAt: observation.ObservedAt,
	}, releaseID)
	if err != nil {
		return false, err
	}
	if outcome == redisx.GitHubQuotaObservationStale {
		quotaLog.Printf("ignored stale observation bucket=%s", bucket)
	}
	return released, nil
}

// Reserve atomically reserves capacity in one bucket. It returns an
// *UnavailableError wrapping ErrParked, ErrExhausted, or ErrUnknown when the
// bucket cannot admit the request.
func (s *Service) Reserve(ctx context.Context, bucket BucketID, request ReservationRequest) (Reservation, error) {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		return Reservation{}, err
	}
	if request.EstimatedCost <= 0 || request.MinimumRemain < 0 || request.TTL < 0 {
		return Reservation{}, errors.New("github quota reservation requires a positive cost and non-negative minimum remain and TTL")
	}
	ttl := request.TTL
	if ttl == 0 {
		ttl = s.reservationTTL
	}
	id, err := newReservationID()
	if err != nil {
		return Reservation{}, err
	}
	admission, expires, state, err := s.store.ReserveGitHubQuota(
		ctx, bucket.storageKey(), id, int64(request.EstimatedCost), int64(s.floor(request.MinimumRemain)), ttl)
	if err != nil {
		return Reservation{}, err
	}
	switch admission {
	case redisx.GitHubQuotaAdmitted:
		return Reservation{ID: id, Bucket: bucket, Amount: request.EstimatedCost, ExpiresAt: expires}, nil
	case redisx.GitHubQuotaParked:
		return Reservation{}, s.unavailable(bucket, StatusParked, state)
	case redisx.GitHubQuotaExhausted:
		return Reservation{}, s.unavailable(bucket, StatusExhausted, state)
	case redisx.GitHubQuotaUnknown:
		return Reservation{}, s.unavailable(bucket, StatusUnknown, state)
	default:
		return Reservation{}, errors.New("github quota reservation ID collided")
	}
}

// Release returns unused reserved capacity. Releasing an already expired or
// committed reservation is not an error.
func (s *Service) Release(ctx context.Context, reservation Reservation) error {
	bucket, err := normalizeBucket(reservation.Bucket)
	if err != nil {
		return err
	}
	if reservation.ID == "" {
		return errors.New("github quota release requires a reservation")
	}
	_, _, err = s.store.ReleaseGitHubQuota(ctx, bucket.storageKey(), reservation.ID)
	return err
}

// Park makes a bucket temporarily unavailable until the supplied instant
// without changing its recorded quota. Parking only ever extends.
func (s *Service) Park(ctx context.Context, bucket BucketID, until time.Time, reason string) error {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		return err
	}
	reason = sanitizeReason(reason)
	extended, _, err := s.store.ParkGitHubQuota(ctx, bucket.storageKey(), until, reason)
	if err != nil {
		return err
	}
	if extended {
		quotaLog.Printf("parked bucket=%s until=%s reason=%q", bucket, until.UTC().Format(time.RFC3339), reason)
	}
	return nil
}

// Unpark clears a bucket's parking, for example to lift an operator
// suspension.
func (s *Service) Unpark(ctx context.Context, bucket BucketID) error {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		return err
	}
	_, err = s.store.UnparkGitHubQuota(ctx, bucket.storageKey())
	return err
}

// State reports a bucket's current quota, reservations, parking, and status.
func (s *Service) State(ctx context.Context, bucket BucketID) (BucketState, error) {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		return BucketState{}, err
	}
	state, err := s.store.GitHubQuotaSnapshot(ctx, bucket.storageKey())
	if err != nil {
		return BucketState{}, err
	}
	return s.describe(bucket, state), nil
}

// States reports every supplied bucket for operator observability.
func (s *Service) States(ctx context.Context, buckets []BucketID) ([]BucketState, error) {
	states := make([]BucketState, 0, len(buckets))
	for _, bucket := range buckets {
		state, err := s.State(ctx, bucket)
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, nil
}

// Select chooses the candidate best able to satisfy the requirement. It
// prefers buckets that are not parked, have known quota, can satisfy the
// requested minimum remain after the estimated cost, and have the greatest
// available headroom; ties keep candidate order. Selection does not reserve
// capacity: callers reserve on the selected bucket, which remains the atomic
// admission decision.
func (s *Service) Select(ctx context.Context, candidates []BucketID, requirement Requirement) (BucketID, error) {
	if requirement.EstimatedCost < 0 || requirement.MinimumRemain < 0 {
		return BucketID{}, errors.New("github quota requirement must not be negative")
	}
	floor := s.floor(requirement.MinimumRemain)
	seen := make(map[BucketID]struct{}, len(candidates))
	var best *BucketState
	var denial *UnavailableError
	for _, candidate := range candidates {
		bucket, err := normalizeBucket(candidate)
		if err != nil {
			return BucketID{}, err
		}
		if _, duplicate := seen[bucket]; duplicate {
			continue
		}
		seen[bucket] = struct{}{}
		state, err := s.State(ctx, bucket)
		if err != nil {
			return BucketID{}, err
		}
		status := state.Status
		if status == StatusAvailable && state.Available-requirement.EstimatedCost < floor {
			status = StatusExhausted
		}
		if status != StatusAvailable {
			denial = preferDenial(denial, s.unavailableFromState(state, status))
			continue
		}
		if best == nil || state.Available > best.Available {
			best = &state
		}
	}
	if best != nil {
		return best.Bucket, nil
	}
	if denial == nil {
		return BucketID{}, ErrNoCandidates
	}
	return BucketID{}, denial
}

// preferDenial keeps the most actionable reason: exhausted before parked
// before unknown, and the earliest retry within the same reason.
func preferDenial(current, next *UnavailableError) *UnavailableError {
	rank := map[Status]int{StatusExhausted: 0, StatusParked: 1, StatusUnknown: 2}
	if current == nil || rank[next.Status] < rank[current.Status] {
		return next
	}
	if rank[next.Status] == rank[current.Status] && !next.RetryAt.IsZero() &&
		(current.RetryAt.IsZero() || next.RetryAt.Before(current.RetryAt)) {
		return next
	}
	return current
}

func (s *Service) floor(minimumRemain int) int {
	return max(minimumRemain, s.safetyReserve)
}

func (s *Service) describe(bucket BucketID, state redisx.GitHubQuotaState) BucketState {
	available := max(state.Remaining-state.Reserved, 0)
	described := BucketState{
		Bucket:      bucket,
		Limit:       int(state.Limit),
		Remaining:   int(state.Remaining),
		Reserved:    int(state.Reserved),
		Available:   int(available),
		ResetAt:     state.ResetAt,
		ObservedAt:  state.ObservedAt,
		ParkedUntil: state.ParkedUntil,
		ParkReason:  state.ParkReason,
		CheckedAt:   state.Now,
	}
	switch {
	case state.ParkedUntil.After(state.Now):
		described.Status = StatusParked
	case !state.Known || !state.ResetAt.After(state.Now):
		described.Status = StatusUnknown
	case described.Available <= s.safetyReserve:
		described.Status = StatusExhausted
	default:
		described.Status = StatusAvailable
	}
	return described
}

func (s *Service) unavailable(bucket BucketID, status Status, state redisx.GitHubQuotaState) error {
	described := s.describe(bucket, state)
	err := s.unavailableFromState(described, status)
	quotaLog.Printf("reservation denied bucket=%s status=%s", bucket, status)
	return err
}

func (s *Service) unavailableFromState(state BucketState, status Status) *UnavailableError {
	unavailable := &UnavailableError{Bucket: state.Bucket, Status: status}
	switch status {
	case StatusParked:
		unavailable.cause = ErrParked
		unavailable.RetryAt = state.ParkedUntil
	case StatusExhausted:
		unavailable.cause = ErrExhausted
		unavailable.RetryAt = state.ResetAt
	default:
		unavailable.cause = ErrUnknown
	}
	return unavailable
}

func newReservationID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", errors.New("generate github quota reservation ID")
	}
	return hex.EncodeToString(value[:]), nil
}

// sanitizeReason keeps parking reasons short, printable, operator-facing
// labels.
func sanitizeReason(reason string) string {
	reason = strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, strings.TrimSpace(reason))
	const limit = 200
	for len(reason) > limit {
		_, size := utf8.DecodeLastRuneInString(reason)
		reason = reason[:len(reason)-size]
	}
	return reason
}
