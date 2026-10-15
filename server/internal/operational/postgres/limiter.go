package postgres

import (
	"context"
	"math"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var limiterLog = logger.New("cao:operational:postgres:limiter")

type tokenBucket struct {
	Tokens float64
	At     time.Time
}

func (s *Store) TakeRateLimitToken(ctx context.Context, name string, capacity int, period time.Duration) (operational.RateLimitResult, error) {
	return s.TakeRateLimitTokens(ctx, name, capacity, period, 1)
}

func (s *Store) TakeRateLimitTokens(ctx context.Context, name string, capacity int, period time.Duration, cost int) (operational.RateLimitResult, error) {
	if err := names(name); err != nil {
		return operational.RateLimitResult{}, err
	}
	if capacity <= 0 || int64(capacity) > maxQuotaValue || cost <= 0 || cost > capacity ||
		period < time.Millisecond || period > time.Duration(math.MaxInt64/2) {
		return operational.RateLimitResult{}, invalid("invalid capacity, cost, or refill period")
	}
	var result operational.RateLimitResult
	err := s.transact(ctx, func(t *transaction) error {
		k := key{"limiter", name, ""}
		b := tokenBucket{Tokens: float64(capacity), At: t.now}
		if _, err := t.json(k, &b); err != nil {
			return err
		}
		b, result = advanceTokenBucket(b, t.now, capacity, cost, period)
		return t.putJSON(k, b, b.At.Add(2*period))
	})
	if err != nil {
		return operational.RateLimitResult{}, err
	}
	if !result.Allowed {
		limiterLog.Printf("rate limit denied capacity=%d cost=%d retry_after_ms=%d", capacity, cost, result.RetryAfter.Milliseconds())
	}
	return result, nil
}

// advanceTokenBucket refills the bucket for the time elapsed since it was
// last updated, then spends cost tokens when enough are available. A denied
// multi-token request drains the bucket. The returned bucket's timestamp
// never moves backwards.
func advanceTokenBucket(b tokenBucket, now time.Time, capacity, cost int, period time.Duration) (tokenBucket, operational.RateLimitResult) {
	var result operational.RateLimitResult
	millis := float64(period.Milliseconds())
	elapsed := math.Max(0, float64(now.Sub(b.At).Milliseconds()))
	b.Tokens = math.Min(float64(capacity), b.Tokens+elapsed*float64(capacity)/millis)
	result.Allowed = b.Tokens >= float64(cost)
	if result.Allowed {
		b.Tokens -= float64(cost)
	} else if cost > 1 {
		b.Tokens = 0
	}
	result.Remaining = int64(math.Floor(b.Tokens))
	result.ResetAfter = time.Duration(math.Ceil((float64(capacity)-b.Tokens)*millis/float64(capacity))) * time.Millisecond
	if !result.Allowed {
		result.RetryAfter = time.Duration(math.Ceil((float64(cost)-b.Tokens)*millis/float64(capacity))) * time.Millisecond
	}
	if now.After(b.At) {
		b.At = now
	}
	return b, result
}
