package memory

import (
	"context"
	"math/bits"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const maxQuotaValue = int64(1 << 40)

var quotaIdentifier = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
var legacyBudgetPattern = regexp.MustCompile(`^-?[0-9]+\|-?[0-9]+\|-?[0-9]+$`)

type quotaReservation struct {
	cost    int64
	expires time.Time
}

type quotaBucket struct {
	state        operational.GitHubQuotaState
	reservations map[string]quotaReservation
	expires      time.Time
}

type usageKey struct {
	bucket string
	slot   time.Time
}

func (s *Store) quotaName(bucket string) error {
	if !quotaIdentifier.MatchString(bucket) {
		return invalid("invalid quota identifier")
	}
	return s.name(bucket)
}

func quotaSize(bucket string, state operational.GitHubQuotaState) int64 {
	return charge(bucket, state.ParkReason) + 256
}

func (s *Store) pruneQuotas(now time.Time) {
	for name, q := range s.quotas {
		for id, r := range q.reservations {
			if !r.expires.After(now) {
				s.removeQuotaReservation(name, q, id)
			}
		}
		if !q.expires.After(now) {
			for id := range q.reservations {
				s.removeQuotaReservation(name, q, id)
			}
			delete(s.quotas, name)
			s.drop(recordKey{"quota", name, ""})
		}
	}
}

func touchQuota(q *quotaBucket, now time.Time) {
	horizon := now
	if q.state.ResetAt.After(horizon) {
		horizon = q.state.ResetAt
	}
	if q.state.ParkedUntil.After(horizon) {
		horizon = q.state.ParkedUntil
	}
	q.expires = horizon.Add(24 * time.Hour)
}

func quotaState(q *quotaBucket, now time.Time) operational.GitHubQuotaState {
	if q == nil {
		return operational.GitHubQuotaState{Now: now}
	}
	state := q.state
	state.Now, state.Reserved = now, 0
	for _, r := range q.reservations {
		state.Reserved += r.cost
	}
	touchQuota(q, now)
	return state
}

func (s *Store) createQuota(name string) *quotaBucket {
	q := s.quotas[name]
	if q == nil {
		q = &quotaBucket{reservations: make(map[string]quotaReservation)}
		s.quotas[strings.Clone(name)] = q
	}
	return q
}

func (s *Store) quotaCapacity(bucket string) error {
	if s.quotas[bucket] == nil && len(s.quotas) >= s.config.MaxQuotaBuckets {
		return capacity()
	}
	return nil
}

func (s *Store) removeQuotaReservation(bucket string, q *quotaBucket, id string) bool {
	if _, exists := q.reservations[id]; !exists {
		return false
	}
	delete(q.reservations, id)
	s.quotaReservations--
	s.drop(recordKey{"quota-reservation", bucket, id})
	return true
}

func (s *Store) GitHubQuotaSnapshot(ctx context.Context, bucket string) (operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return operational.GitHubQuotaState{}, err
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	return quotaState(s.quotas[bucket], now), nil
}

func (s *Store) ObserveGitHubQuota(ctx context.Context, bucket string, observation operational.GitHubQuotaObservation, releaseID string) (operational.GitHubQuotaObserveOutcome, bool, operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return 0, false, operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return 0, false, operational.GitHubQuotaState{}, err
	}
	if releaseID != "" {
		if err := s.quotaName(releaseID); err != nil {
			return 0, false, operational.GitHubQuotaState{}, err
		}
	}
	if observation.Limit < 0 || observation.Remaining < 0 || observation.Limit > maxQuotaValue ||
		observation.Remaining > maxQuotaValue || observation.ResetAt.IsZero() || observation.ResetAt.UnixMilli() <= 0 ||
		(!observation.ObservedAt.IsZero() && observation.ObservedAt.UnixMilli() <= 0) {
		return 0, false, operational.GitHubQuotaState{}, invalid("invalid quota observation")
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	q := s.quotas[bucket]
	current := quotaState(q, now)
	next := current
	outcome := operational.GitHubQuotaObservationStale
	reset := observation.ResetAt.Truncate(time.Millisecond)
	observed := observation.ObservedAt.Truncate(time.Millisecond)
	if observed.IsZero() {
		observed = now
	}
	if !current.Known || reset.After(current.ResetAt) {
		next.Known, next.Limit, next.Remaining = true, observation.Limit, observation.Remaining
		next.ResetAt, next.ObservedAt = reset, observed
		outcome = operational.GitHubQuotaObservationReplaced
	} else if reset.Equal(current.ResetAt) {
		next.Limit, next.Remaining = observation.Limit, min(current.Remaining, observation.Remaining)
		next.ObservedAt = current.ObservedAt
		if observed.After(next.ObservedAt) {
			next.ObservedAt = observed
		}
		outcome = operational.GitHubQuotaObservationReconciled
	}
	if err := s.quotaCapacity(bucket); err != nil {
		return 0, false, current, err
	}
	changes := map[recordKey]int64{{"quota", bucket, ""}: quotaSize(bucket, next)}
	if releaseID != "" {
		changes[recordKey{"quota-reservation", bucket, releaseID}] = 0
	}
	if err := s.reserve(changes); err != nil {
		return 0, false, current, err
	}
	q = s.createQuota(bucket)
	q.state = next
	released := s.removeQuotaReservation(bucket, q, releaseID)
	return outcome, released, quotaState(q, now), nil
}

func (s *Store) ReserveGitHubQuota(ctx context.Context, bucket, id string, cost, minimum int64, ttl time.Duration) (operational.GitHubQuotaAdmission, time.Time, operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return 0, time.Time{}, operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return 0, time.Time{}, operational.GitHubQuotaState{}, err
	}
	if err := s.quotaName(id); err != nil {
		return 0, time.Time{}, operational.GitHubQuotaState{}, err
	}
	if cost <= 0 || cost > maxQuotaValue || minimum < 0 || minimum > maxQuotaValue ||
		ttl < time.Millisecond || ttl > 24*time.Hour {
		return 0, time.Time{}, operational.GitHubQuotaState{}, invalid("invalid quota reservation cost, floor, or TTL")
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	q := s.quotas[bucket]
	state := quotaState(q, now)
	code := operational.GitHubQuotaAdmitted
	switch {
	case state.ParkedUntil.After(now):
		code = operational.GitHubQuotaParked
	case !state.Known || !state.ResetAt.After(now):
		code = operational.GitHubQuotaUnknown
	case q.reservations[id].cost != 0:
		code = operational.GitHubQuotaDuplicateReservation
	case state.Remaining-state.Reserved-cost < minimum:
		code = operational.GitHubQuotaExhausted
	}
	if code != operational.GitHubQuotaAdmitted {
		return code, time.Time{}, state, nil
	}
	if s.quotaReservations >= s.config.MaxQuotaReservations {
		return 0, time.Time{}, state, capacity()
	}
	if err := s.reserve(map[recordKey]int64{{"quota-reservation", bucket, id}: charge(bucket, id) + 32}); err != nil {
		return 0, time.Time{}, state, err
	}
	expires := now.Add(time.Duration(ttl.Milliseconds()) * time.Millisecond)
	q.reservations[strings.Clone(id)] = quotaReservation{cost, expires}
	s.quotaReservations++
	return code, expires, quotaState(q, now), nil
}

func (s *Store) ReleaseGitHubQuota(ctx context.Context, bucket, id string) (bool, operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return false, operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return false, operational.GitHubQuotaState{}, err
	}
	if err := s.quotaName(id); err != nil {
		return false, operational.GitHubQuotaState{}, err
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	q := s.quotas[bucket]
	released := false
	if q != nil {
		released = s.removeQuotaReservation(bucket, q, id)
	}
	return released, quotaState(q, now), nil
}

func (s *Store) ParkGitHubQuota(ctx context.Context, bucket string, until time.Time, reason string) (bool, operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return false, operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return false, operational.GitHubQuotaState{}, err
	}
	if until.IsZero() || until.UnixMilli() <= 0 || len(reason) > 256 {
		return false, operational.GitHubQuotaState{}, invalid("invalid quota parking time or reason")
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	q := s.quotas[bucket]
	state := quotaState(q, now)
	until = until.Truncate(time.Millisecond)
	if !until.After(state.ParkedUntil) {
		return false, state, nil
	}
	next := state
	next.ParkedUntil, next.ParkReason = until, strings.Clone(reason)
	if err := s.quotaCapacity(bucket); err != nil {
		return false, state, err
	}
	if err := s.reserve(map[recordKey]int64{{"quota", bucket, ""}: quotaSize(bucket, next)}); err != nil {
		return false, state, err
	}
	q = s.createQuota(bucket)
	q.state = next
	return true, quotaState(q, now), nil
}

func (s *Store) UnparkGitHubQuota(ctx context.Context, bucket string) (operational.GitHubQuotaState, error) {
	if err := s.enter(ctx); err != nil {
		return operational.GitHubQuotaState{}, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return operational.GitHubQuotaState{}, err
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	q := s.quotas[bucket]
	if q != nil {
		next := q.state
		next.ParkedUntil, next.ParkReason = time.Time{}, ""
		if err := s.reserve(map[recordKey]int64{{"quota", bucket, ""}: quotaSize(bucket, next)}); err != nil {
			return operational.GitHubQuotaState{}, err
		}
		q.state = next
	}
	return quotaState(q, now), nil
}

func (s *Store) RecordGitHubQuotaUsage(ctx context.Context, bucket string, at time.Time, limit, used, reserved int64) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.quotaName(bucket); err != nil {
		return false, err
	}
	if at.IsZero() || limit < 0 || limit > maxQuotaValue || used < 0 || used > limit || reserved < 0 || reserved > maxQuotaValue {
		return false, invalid("invalid quota usage observation")
	}
	now := s.config.Clock()
	s.prune(now)
	slot := at.UTC().Truncate(operational.GitHubQuotaUsageInterval)
	if !slot.Add(operational.GitHubQuotaUsageInterval).After(now.Add(-operational.GitHubQuotaUsageRetention)) ||
		slot.After(now.Add(operational.GitHubQuotaUsageInterval)) {
		return false, nil
	}
	k := usageKey{bucket, slot}
	current, exists := s.usage[k]
	if !exists && len(s.usage) >= s.config.MaxQuotaUsageSamples {
		return false, capacity()
	}
	if exists {
		priorUsed, priorLimit := current.Used, current.Limit
		if priorUsed < 0 || priorLimit < 0 || used < 0 || limit < 0 {
			return false, invalid("negative quota usage accounting")
		}
		hiA, loA := bits.Mul64(uint64(priorUsed), uint64(limit))
		hiB, loB := bits.Mul64(uint64(used), uint64(priorLimit))
		if hiA > hiB || (hiA == hiB && (loA > loB || (loA == loB && current.Used > used))) {
			limit, used = current.Limit, current.Used
		}
		reserved = max(reserved, current.Reserved)
	}
	if err := s.reserve(map[recordKey]int64{{"usage", bucket, slot.Format(time.RFC3339)}: charge(bucket) + 64}); err != nil {
		return false, err
	}
	bucket = strings.Clone(bucket)
	s.usage[usageKey{bucket, slot}] = operational.GitHubQuotaUsageSample{
		Bucket: bucket, Slot: slot, Limit: limit, Used: used, Reserved: reserved,
	}
	return true, nil
}

func (s *Store) GitHubQuotaUsage(ctx context.Context) ([]operational.GitHubQuotaUsageSample, time.Time, error) {
	if err := s.enter(ctx); err != nil {
		return nil, time.Time{}, err
	}
	defer s.mu.Unlock()
	now := s.config.Clock()
	s.prune(now)
	first := now.Add(-operational.GitHubQuotaUsageRetention).UTC().Truncate(operational.GitHubQuotaUsageInterval).Add(operational.GitHubQuotaUsageInterval)
	latest := now.UTC().Truncate(operational.GitHubQuotaUsageInterval)
	samples := make([]operational.GitHubQuotaUsageSample, 0, len(s.usage))
	for k, v := range s.usage {
		if !k.slot.Before(first) && !k.slot.After(latest) {
			samples = append(samples, v)
		}
	}
	sort.Slice(samples, func(i, j int) bool {
		if samples[i].Slot.Equal(samples[j].Slot) {
			return samples[i].Bucket < samples[j].Bucket
		}
		return samples[i].Slot.Before(samples[j].Slot)
	})
	return samples, now, nil
}

func legacyBudget(value string) (remaining, reset, parked int64, ok bool) {
	if !legacyBudgetPattern.MatchString(value) {
		return 0, 0, 0, false
	}
	parts := strings.Split(value, "|")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	numbers := [3]int64{}
	for i, part := range parts {
		var err error
		numbers[i], err = strconv.ParseInt(part, 10, 64)
		if err != nil {
			return 0, 0, 0, false
		}
	}
	return numbers[0], numbers[1], numbers[2], true
}

func budgetValue(remaining, reset, parked int64) string {
	return strconv.FormatInt(remaining, 10) + "|" + strconv.FormatInt(reset, 10) + "|" + strconv.FormatInt(parked, 10)
}

func (s *Store) ReserveRateLimit(ctx context.Context, name, field string, floor, cost int, now int64) (int, error) {
	if err := s.enter(ctx); err != nil {
		return 0, err
	}
	defer s.mu.Unlock()
	if err := s.name(name, field); err != nil {
		return 0, err
	}
	if floor < 0 || cost <= 0 || int64(cost) > maxQuotaValue || now <= 0 {
		return 0, invalid("invalid legacy budget reservation")
	}
	remaining, reset, parked, ok := legacyBudget(s.attributes[name][field])
	if !ok {
		return 3, nil
	}
	switch {
	case parked > now:
		return 1, nil
	case reset > 0 && reset < now:
		return 3, nil
	case remaining <= int64(floor):
		return 2, nil
	}
	return 0, s.writeAttribute(name, field, budgetValue(max(remaining-int64(cost), 0), reset, parked))
}

func (s *Store) ObserveRateLimit(ctx context.Context, name, field string, remaining int, reset int64) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name, field); err != nil {
		return err
	}
	if remaining < 0 || int64(remaining) > maxQuotaValue || reset < 0 {
		return invalid("invalid legacy budget observation")
	}
	current, currentReset, parked, exists := legacyBudget(s.attributes[name][field])
	n := int64(remaining)
	if exists && currentReset == reset {
		n = min(current, n)
	}
	return s.writeAttribute(name, field, budgetValue(n, reset, parked))
}

func (s *Store) ParkRateLimit(ctx context.Context, name, field string, parkedTo int64) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name, field); err != nil {
		return err
	}
	if parkedTo < 0 {
		return invalid("invalid legacy budget parking time")
	}
	remaining, reset, parked, _ := legacyBudget(s.attributes[name][field])
	return s.writeAttribute(name, field, budgetValue(remaining, reset, max(parked, parkedTo)))
}
