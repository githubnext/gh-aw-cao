package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// RateLimitResult describes the state of a token bucket after one attempted
// token consumption.
type RateLimitResult struct {
	Allowed    bool
	Remaining  int
	RetryAfter time.Duration
	ResetAfter time.Duration
}

// TakeRateLimitToken atomically consumes one token from a Redis-backed token
// bucket. Redis TIME is used so every server replica observes the same clock.
func (s *Store) TakeRateLimitToken(
	ctx context.Context,
	key string,
	capacity int,
	refillPeriod time.Duration,
) (RateLimitResult, error) {
	if capacity <= 0 || refillPeriod <= 0 {
		return RateLimitResult{}, errors.New("rate limit capacity and refill period must be positive")
	}
	script := `
local current = redis.call("TIME")
local now = current[1] * 1000 + math.floor(current[2] / 1000)
local state = redis.call("HMGET", KEYS[1], "tokens", "updated")
local tokens = tonumber(state[1]) or tonumber(ARGV[1])
local updated = tonumber(state[2]) or now
local elapsed = math.max(0, now - updated)
local capacity = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
tokens = math.min(capacity, tokens + elapsed * capacity / period)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
local retry = 0
if allowed == 0 then
  retry = math.ceil((1 - tokens) * period / capacity)
end
local reset = math.ceil((capacity - tokens) * period / capacity)
redis.call("HSET", KEYS[1], "tokens", tokens, "updated", now)
redis.call("PEXPIRE", KEYS[1], math.ceil(period * 2))
return {allowed, math.floor(tokens), retry, reset}`
	value, err := s.Client.Do(
		ctx,
		"EVAL",
		script,
		"1",
		s.Key("rate-limit:"+key),
		strconv.Itoa(capacity),
		strconv.FormatInt(refillPeriod.Milliseconds(), 10),
	)
	if err != nil {
		return RateLimitResult{}, fmt.Errorf("update Redis rate limit: %w", err)
	}
	items, ok := value.([]any)
	if !ok || len(items) != 4 {
		return RateLimitResult{}, errors.New("Redis rate limit returned an invalid response")
	}
	parsed := make([]int64, len(items))
	for index, item := range items {
		parsed[index], err = strconv.ParseInt(fmt.Sprint(item), 10, 64)
		if err != nil {
			return RateLimitResult{}, errors.New("Redis rate limit returned an invalid response")
		}
	}
	if parsed[0] != 0 && parsed[0] != 1 {
		return RateLimitResult{}, errors.New("Redis rate limit returned an invalid response")
	}
	maximumDuration := refillPeriod.Milliseconds()
	if parsed[1] < 0 || parsed[1] > int64(capacity) ||
		parsed[2] < 0 || parsed[2] > maximumDuration ||
		parsed[3] < 0 || parsed[3] > maximumDuration {
		return RateLimitResult{}, errors.New("Redis rate limit returned an invalid response")
	}
	return RateLimitResult{
		Allowed:    parsed[0] == 1,
		Remaining:  int(parsed[1]),
		RetryAfter: time.Duration(parsed[2]) * time.Millisecond,
		ResetAfter: time.Duration(parsed[3]) * time.Millisecond,
	}, nil
}
