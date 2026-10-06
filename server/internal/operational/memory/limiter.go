package memory

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type tokenBucket struct {
	tokens           float64
	updated, expires time.Time
}

func (s *Store) TakeRateLimitToken(ctx context.Context, key string, capacity int, period time.Duration) (operational.RateLimitResult, error) {
	return s.TakeRateLimitTokens(ctx, key, capacity, period, 1)
}

func (s *Store) TakeRateLimitTokens(ctx context.Context, key string, limit int, period time.Duration, cost int) (operational.RateLimitResult, error) {
	if err := s.enter(ctx); err != nil {
		return operational.RateLimitResult{}, err
	}
	defer s.mu.Unlock()
	if err := s.name(key); err != nil {
		return operational.RateLimitResult{}, err
	}
	if limit <= 0 || int64(limit) > maxQuotaValue || cost <= 0 || cost > limit || period < time.Millisecond || period > time.Duration(math.MaxInt64/2) {
		return operational.RateLimitResult{}, invalid("invalid token bucket capacity, cost, or refill period")
	}
	now := s.config.Clock().Truncate(time.Millisecond)
	s.prune(now)
	v, exists := s.buckets[key]
	if !exists {
		if len(s.buckets) >= s.config.MaxRateLimitSubjects {
			return operational.RateLimitResult{}, capacity()
		}
		if err := s.reserve(map[recordKey]int64{{"bucket", key, ""}: charge(key)}); err != nil {
			return operational.RateLimitResult{}, err
		}
		v = tokenBucket{tokens: float64(limit), updated: now}
	}
	elapsed := math.Max(0, float64(now.Sub(v.updated).Milliseconds()))
	millis := float64(period.Milliseconds())
	v.tokens = math.Min(float64(limit), v.tokens+elapsed*float64(limit)/millis)
	allowed := v.tokens >= float64(cost)
	if allowed {
		v.tokens -= float64(cost)
	} else if cost > 1 {
		v.tokens = 0
	}
	result := operational.RateLimitResult{Allowed: allowed, Remaining: int64(math.Floor(v.tokens)),
		ResetAfter: time.Duration(math.Ceil((float64(limit)-v.tokens)*millis/float64(limit))) * time.Millisecond}
	if !allowed {
		result.RetryAfter = time.Duration(math.Ceil((float64(cost)-v.tokens)*millis/float64(limit))) * time.Millisecond
	}
	v.updated, v.expires = now, now.Add(time.Duration(period.Milliseconds()*2)*time.Millisecond)
	s.buckets[strings.Clone(key)] = v
	return result, nil
}
