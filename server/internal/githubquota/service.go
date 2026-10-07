package githubquota

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"go.opentelemetry.io/otel/attribute"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
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
	Limit     int
	Remaining int
	ResetAt   time.Time
	// ObservedAt is when GitHub produced the response. When zero, the shared
	// The operational store's clock is recorded so replicas with skewed clocks agree.
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
	// CheckedAt is the operational store's clock at which the state was read.
	CheckedAt time.Time `json:"checkedAt"`
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
	store          operational.GitHubQuotaStore
	reservationTTL time.Duration
	safetyReserve  int
}

// New constructs a Service over an atomic store.
func New(store operational.GitHubQuotaStore, options Options) (*Service, error) {
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
func (s *Service) Observe(ctx context.Context, bucket BucketID, observation Observation) (err error) {
	ctx, op := startOperation(ctx, "observe", bucket)
	defer func() { op.finish(ctx, err) }()
	_, err = s.observe(ctx, op, bucket, observation, "")
	return err
}

// Commit reconciles a reservation with the authoritative observation taken
// after its work ran. The observation is recorded and the reservation removed
// in one atomic step, so the consumed capacity is counted exactly once.
func (s *Service) Commit(ctx context.Context, reservation Reservation, observation Observation) (err error) {
	ctx, op := startOperation(ctx, "commit", reservation.Bucket)
	defer func() { op.finish(ctx, err) }()
	if reservation.ID == "" {
		op.outcome = outcomeInvalid
		return errors.New("github quota commit requires a reservation")
	}
	released, err := s.observe(ctx, op, reservation.Bucket, observation, reservation.ID)
	if err != nil {
		return err
	}
	if !released {
		op.outcome = outcomeExpired
		quotaLog.Printf("committed reservation had already expired bucket=%s", reservation.Bucket.Normalize())
	}
	return nil
}

func (s *Service) observe(
	ctx context.Context, op *operation, bucket BucketID, observation Observation, releaseID string,
) (bool, error) {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return false, err
	}
	op.setBucket(bucket)
	if observation.Limit < 0 || observation.Remaining < 0 || observation.Remaining > observation.Limit {
		op.outcome = outcomeInvalid
		return false, errors.New("github quota observation requires 0 <= remaining <= limit")
	}
	if observation.ResetAt.IsZero() {
		op.outcome = outcomeInvalid
		return false, errors.New("github quota observation requires a reset time")
	}
	outcome, released, state, err := s.store.ObserveGitHubQuota(ctx, bucket.storageKey(), operational.GitHubQuotaObservation{
		Limit:      int64(observation.Limit),
		Remaining:  int64(observation.Remaining),
		ResetAt:    observation.ResetAt,
		ObservedAt: observation.ObservedAt,
	}, releaseID)
	if err != nil {
		quotaLog.Printf("observation failed bucket=%s", bucket)
		return false, err
	}
	described := s.describe(bucket, state)
	recordBucketState(ctx, described)
	if outcome != operational.GitHubQuotaObservationStale {
		s.recordUsage(ctx, bucket, state)
	}
	switch outcome {
	case operational.GitHubQuotaObservationStale:
		op.outcome = outcomeStale
		quotaLog.Printf("ignored stale observation bucket=%s", bucket)
	case operational.GitHubQuotaObservationReplaced:
		op.outcome = outcomeReplaced
		quotaLog.Printf("observation started reset window bucket=%s remaining=%d limit=%d reset=%s",
			bucket, described.Remaining, described.Limit, described.ResetAt.Format(time.RFC3339))
	default:
		op.outcome = outcomeReconciled
		quotaLog.Printf("observation reconciled bucket=%s remaining=%d reserved=%d released=%t",
			bucket, described.Remaining, described.Reserved, released)
	}
	return released, nil
}

// Reserve atomically reserves capacity in one bucket. It returns an
// *UnavailableError wrapping ErrParked, ErrExhausted, or ErrUnknown when the
// bucket cannot admit the request.
func (s *Service) Reserve(ctx context.Context, bucket BucketID, request ReservationRequest) (_ Reservation, err error) {
	ctx, op := startOperation(ctx, "reserve", bucket)
	defer func() { op.finish(ctx, err) }()
	bucket, err = normalizeBucket(bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return Reservation{}, err
	}
	op.setBucket(bucket)
	if request.EstimatedCost <= 0 || request.MinimumRemain < 0 || request.TTL < 0 {
		op.outcome = outcomeInvalid
		return Reservation{}, errors.New("github quota reservation requires a positive cost and non-negative minimum remain and TTL")
	}
	ttl := request.TTL
	if ttl == 0 {
		ttl = s.reservationTTL
	}
	floor := s.floor(request.MinimumRemain)
	op.span.SetAttributes(
		attribute.Int(attributeCost, request.EstimatedCost),
		attribute.Int(attributeFloor, floor))
	id, err := newReservationID()
	if err != nil {
		return Reservation{}, err
	}
	admission, expires, state, err := s.store.ReserveGitHubQuota(
		ctx, bucket.storageKey(), id, int64(request.EstimatedCost), int64(floor), ttl)
	if err != nil {
		quotaLog.Printf("reservation failed bucket=%s", bucket)
		return Reservation{}, err
	}
	recordBucketState(ctx, s.describe(bucket, state))
	switch admission {
	case operational.GitHubQuotaAdmitted:
		op.outcome = outcomeAdmitted
		quotaLog.Printf("reservation admitted bucket=%s cost=%d floor=%d remaining=%d reserved=%d expires=%s",
			bucket, request.EstimatedCost, floor, state.Remaining, state.Reserved, expires.Format(time.RFC3339))
		return Reservation{ID: id, Bucket: bucket, Amount: request.EstimatedCost, ExpiresAt: expires}, nil
	case operational.GitHubQuotaParked:
		return Reservation{}, s.unavailable(bucket, StatusParked, state)
	case operational.GitHubQuotaExhausted:
		return Reservation{}, s.unavailable(bucket, StatusExhausted, state)
	case operational.GitHubQuotaUnknown:
		return Reservation{}, s.unavailable(bucket, StatusUnknown, state)
	default:
		return Reservation{}, errors.New("github quota reservation ID collided")
	}
}

// Release returns unused reserved capacity. Releasing an already expired or
// committed reservation is not an error.
func (s *Service) Release(ctx context.Context, reservation Reservation) (err error) {
	ctx, op := startOperation(ctx, "release", reservation.Bucket)
	defer func() { op.finish(ctx, err) }()
	bucket, err := normalizeBucket(reservation.Bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return err
	}
	op.setBucket(bucket)
	if reservation.ID == "" {
		op.outcome = outcomeInvalid
		return errors.New("github quota release requires a reservation")
	}
	released, state, err := s.store.ReleaseGitHubQuota(ctx, bucket.storageKey(), reservation.ID)
	if err != nil {
		quotaLog.Printf("release failed bucket=%s", bucket)
		return err
	}
	recordBucketState(ctx, s.describe(bucket, state))
	if !released {
		op.outcome = outcomeExpired
	}
	quotaLog.Printf("reservation released bucket=%s amount=%d released=%t reserved=%d",
		bucket, reservation.Amount, released, state.Reserved)
	return nil
}

// Park makes a bucket temporarily unavailable until the supplied instant
// without changing its recorded quota. Parking only ever extends.
func (s *Service) Park(ctx context.Context, bucket BucketID, until time.Time, reason string) (err error) {
	ctx, op := startOperation(ctx, "park", bucket)
	defer func() { op.finish(ctx, err) }()
	bucket, err = normalizeBucket(bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return err
	}
	op.setBucket(bucket)
	reason = sanitizeReason(reason)
	extended, state, err := s.store.ParkGitHubQuota(ctx, bucket.storageKey(), until, reason)
	if err != nil {
		quotaLog.Printf("parking failed bucket=%s", bucket)
		return err
	}
	recordBucketState(ctx, s.describe(bucket, state))
	if extended {
		op.outcome = outcomeExtended
		quotaLog.Printf("parked bucket=%s until=%s reason=%q", bucket, until.UTC().Format(time.RFC3339), reason)
	} else {
		op.outcome = outcomeUnchanged
		quotaLog.Printf("parking not extended bucket=%s parked_until=%s", bucket, state.ParkedUntil.Format(time.RFC3339))
	}
	return nil
}

// Unpark clears a bucket's parking, for example to lift an operator
// suspension.
func (s *Service) Unpark(ctx context.Context, bucket BucketID) (err error) {
	ctx, op := startOperation(ctx, "unpark", bucket)
	defer func() { op.finish(ctx, err) }()
	bucket, err = normalizeBucket(bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return err
	}
	op.setBucket(bucket)
	state, err := s.store.UnparkGitHubQuota(ctx, bucket.storageKey())
	if err != nil {
		quotaLog.Printf("unpark failed bucket=%s", bucket)
		return err
	}
	recordBucketState(ctx, s.describe(bucket, state))
	quotaLog.Printf("unparked bucket=%s", bucket)
	return nil
}

// State reports a bucket's current quota, reservations, parking, and status.
func (s *Service) State(ctx context.Context, bucket BucketID) (_ BucketState, err error) {
	ctx, op := startOperation(ctx, "state", bucket)
	defer func() { op.finish(ctx, err) }()
	state, err := s.state(ctx, op, bucket)
	if err == nil {
		op.span.SetAttributes(attribute.String(attributeStatus, string(state.Status)))
	}
	return state, err
}

func (s *Service) state(ctx context.Context, op *operation, bucket BucketID) (BucketState, error) {
	bucket, err := normalizeBucket(bucket)
	if err != nil {
		op.outcome = outcomeInvalid
		return BucketState{}, err
	}
	op.setBucket(bucket)
	state, err := s.store.GitHubQuotaSnapshot(ctx, bucket.storageKey())
	if err != nil {
		quotaLog.Printf("snapshot failed bucket=%s", bucket)
		return BucketState{}, err
	}
	described := s.describe(bucket, state)
	recordBucketState(ctx, described)
	return described, nil
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
func (s *Service) Select(ctx context.Context, candidates []BucketID, requirement Requirement) (_ BucketID, err error) {
	ctx, op := startOperation(ctx, "select", BucketID{})
	defer func() { op.finish(ctx, err) }()
	op.span.SetAttributes(
		attribute.Int(attributeCandidates, len(candidates)),
		attribute.Int(attributeCost, requirement.EstimatedCost))
	if requirement.EstimatedCost < 0 || requirement.MinimumRemain < 0 {
		op.outcome = outcomeInvalid
		return BucketID{}, errors.New("github quota requirement must not be negative")
	}
	floor := s.floor(requirement.MinimumRemain)
	op.span.SetAttributes(attribute.Int(attributeFloor, floor))
	seen := make(map[BucketID]struct{}, len(candidates))
	var best *BucketState
	var denial *UnavailableError
	for _, candidate := range candidates {
		bucket, err := normalizeBucket(candidate)
		if err != nil {
			op.outcome = outcomeInvalid
			return BucketID{}, err
		}
		if _, duplicate := seen[bucket]; duplicate {
			continue
		}
		seen[bucket] = struct{}{}
		snapshot, err := s.store.GitHubQuotaSnapshot(ctx, bucket.storageKey())
		if err != nil {
			quotaLog.Printf("selection snapshot failed bucket=%s", bucket)
			return BucketID{}, err
		}
		state := s.describe(bucket, snapshot)
		recordBucketState(ctx, state)
		status := state.Status
		if status != StatusParked && status != StatusUnknown {
			status = StatusAvailable
			if state.Available-requirement.EstimatedCost < floor {
				status = StatusExhausted
			}
		}
		quotaLog.Printf("selection candidate bucket=%s status=%s available=%d", bucket, status, state.Available)
		if status != StatusAvailable {
			denial = preferDenial(denial, s.unavailableFromState(state, status))
			continue
		}
		if best == nil || state.Available > best.Available {
			best = &state
		}
	}
	if best != nil {
		op.outcome = outcomeSelected
		op.setBucket(best.Bucket)
		quotaLog.Printf("selected bucket=%s available=%d candidates=%d", best.Bucket, best.Available, len(seen))
		return best.Bucket, nil
	}
	if denial == nil {
		quotaLog.Printf("selection had no candidates")
		return BucketID{}, ErrNoCandidates
	}
	quotaLog.Printf("selection found no usable bucket candidates=%d status=%s", len(seen), denial.Status)
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

func (s *Service) describe(bucket BucketID, state operational.GitHubQuotaState) BucketState {
	available := max(state.Remaining-state.Reserved, 0)
	described := BucketState{
		Bucket:      bucket,
		Limit:       boundedInt(state.Limit),
		Remaining:   boundedInt(state.Remaining),
		Reserved:    boundedInt(state.Reserved),
		Available:   boundedInt(available),
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

func (s *Service) unavailable(bucket BucketID, status Status, state operational.GitHubQuotaState) error {
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

// boundedInt converts a persisted quota count to int, saturating so a
// corrupted or oversized value cannot overflow on 32-bit platforms.
func boundedInt(value int64) int {
	if value <= 0 {
		return 0
	}
	if value > math.MaxInt32 {
		return math.MaxInt32
	}
	return int(value)
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
