package githubquota

import (
	"context"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// memoryStore is an in-memory Store mirroring the redisx quota scripts so the
// service's semantics are testable without Redis.
type memoryStore struct {
	mu      sync.Mutex
	now     time.Time
	buckets map[string]*memoryBucket
}

type memoryBucket struct {
	known        bool
	limit        int64
	remaining    int64
	reset        time.Time
	observed     time.Time
	parked       time.Time
	parkReason   string
	reservations map[string]memoryReservation
}

type memoryReservation struct {
	amount  int64
	expires time.Time
}

func newMemoryStore(now time.Time) *memoryStore {
	return &memoryStore{now: now, buckets: map[string]*memoryBucket{}}
}

func (m *memoryStore) advance(duration time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = m.now.Add(duration)
}

func (m *memoryStore) bucket(key string) *memoryBucket {
	bucket, ok := m.buckets[key]
	if !ok {
		bucket = &memoryBucket{reservations: map[string]memoryReservation{}}
		m.buckets[key] = bucket
	}
	for id, reservation := range bucket.reservations {
		if !reservation.expires.After(m.now) {
			delete(bucket.reservations, id)
		}
	}
	return bucket
}

func (m *memoryStore) state(bucket *memoryBucket) redisx.GitHubQuotaState {
	var reserved int64
	for _, reservation := range bucket.reservations {
		reserved += reservation.amount
	}
	return redisx.GitHubQuotaState{
		Known: bucket.known, Limit: bucket.limit, Remaining: bucket.remaining, Reserved: reserved,
		ResetAt: bucket.reset, ObservedAt: bucket.observed, ParkedUntil: bucket.parked,
		ParkReason: bucket.parkReason, Now: m.now,
	}
}

func (m *memoryStore) GitHubQuotaSnapshot(_ context.Context, key string) (redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state(m.bucket(key)), nil
}

func (m *memoryStore) ObserveGitHubQuota(
	_ context.Context, key string, observation redisx.GitHubQuotaObservation, releaseID string,
) (redisx.GitHubQuotaObserveOutcome, bool, redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket := m.bucket(key)
	_, released := bucket.reservations[releaseID]
	delete(bucket.reservations, releaseID)
	outcome := redisx.GitHubQuotaObservationStale
	reset := time.UnixMilli(observation.ResetAt.UnixMilli()).UTC()
	switch {
	case !bucket.known || reset.After(bucket.reset):
		bucket.known, bucket.limit, bucket.remaining = true, observation.Limit, observation.Remaining
		bucket.reset, bucket.observed = reset, observation.ObservedAt
		outcome = redisx.GitHubQuotaObservationReplaced
	case reset.Equal(bucket.reset):
		bucket.limit = observation.Limit
		bucket.remaining = min(bucket.remaining, observation.Remaining)
		if observation.ObservedAt.After(bucket.observed) {
			bucket.observed = observation.ObservedAt
		}
		outcome = redisx.GitHubQuotaObservationReconciled
	}
	return outcome, released, m.state(bucket), nil
}

func (m *memoryStore) ReserveGitHubQuota(
	_ context.Context, key, id string, cost, minimumRemain int64, ttl time.Duration,
) (redisx.GitHubQuotaAdmission, time.Time, redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket := m.bucket(key)
	state := m.state(bucket)
	switch {
	case bucket.parked.After(m.now):
		return redisx.GitHubQuotaParked, time.Time{}, state, nil
	case !bucket.known || !bucket.reset.After(m.now):
		return redisx.GitHubQuotaUnknown, time.Time{}, state, nil
	case bucket.reservations[id] != (memoryReservation{}):
		return redisx.GitHubQuotaDuplicateReservation, time.Time{}, state, nil
	case bucket.remaining-state.Reserved-cost < minimumRemain:
		return redisx.GitHubQuotaExhausted, time.Time{}, state, nil
	}
	expires := m.now.Add(ttl)
	bucket.reservations[id] = memoryReservation{amount: cost, expires: expires}
	return redisx.GitHubQuotaAdmitted, expires, m.state(bucket), nil
}

func (m *memoryStore) ReleaseGitHubQuota(_ context.Context, key, id string) (bool, redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket := m.bucket(key)
	_, released := bucket.reservations[id]
	delete(bucket.reservations, id)
	return released, m.state(bucket), nil
}

func (m *memoryStore) ParkGitHubQuota(
	_ context.Context, key string, until time.Time, reason string,
) (bool, redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket := m.bucket(key)
	if !until.After(bucket.parked) {
		return false, m.state(bucket), nil
	}
	bucket.parked, bucket.parkReason = until, reason
	return true, m.state(bucket), nil
}

func (m *memoryStore) UnparkGitHubQuota(_ context.Context, key string) (redisx.GitHubQuotaState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket := m.bucket(key)
	bucket.parked, bucket.parkReason = time.Time{}, ""
	return m.state(bucket), nil
}
