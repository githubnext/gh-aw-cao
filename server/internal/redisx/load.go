package redisx

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var loadLog = logger.New("cao:redis:load")

// A load is an exponentially decaying event count. One event contributes 1
// immediately and half as much after each half-life; idle keys expire.
const loadStep = `
local now_parts = redis.call("TIME")
local now = tonumber(now_parts[1]) + tonumber(now_parts[2]) / 1000000
local previous = redis.call("GET", KEYS[#KEYS])
local value = 0
if previous then
  local amount, at = string.match(previous, "^([^|]+)|([^|]+)$")
  if tonumber(amount) and tonumber(at) then
    value = tonumber(amount) * math.pow(0.5, math.max(0, now - tonumber(at)) / tonumber(ARGV[2]))
  end
end
value = value + tonumber(ARGV[1])
redis.call("SET", KEYS[#KEYS], tostring(value) .. "|" .. tostring(now), "EX", ARGV[3])
return tostring(value)`

var loadName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// loadRejectionReason identifies which precondition rejected a load
// observation, so a caller's rejection is diagnosable without logging the
// load name or the observed amount itself.
type loadRejectionReason string

const (
	loadRejectionReasonNone             loadRejectionReason = "none"
	loadRejectionReasonNameOrHalfLife   loadRejectionReason = "name-or-half-life"
	loadRejectionReasonAmountNotFinite  loadRejectionReason = "amount-not-finite"
	loadRejectionReasonAmountOutOfRange loadRejectionReason = "amount-out-of-range"
)

// classifyLoadObservation applies AddLoad's standard preconditions for a
// load name, half-life, and observed amount, reporting the first one that
// fails. It is a pure function extracted from AddLoad so each precondition
// is independently testable without a Redis client.
func classifyLoadObservation(name string, amount float64, halfLife time.Duration) loadRejectionReason {
	if !loadName.MatchString(name) || halfLife < time.Second || halfLife > 24*time.Hour {
		return loadRejectionReasonNameOrHalfLife
	}
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return loadRejectionReasonAmountNotFinite
	}
	if amount < 0 || amount > 1e9 {
		return loadRejectionReasonAmountOutOfRange
	}
	return loadRejectionReasonNone
}

func loadArgs(name string, halfLife time.Duration) (string, string, error) {
	if !loadName.MatchString(name) || halfLife < time.Second || halfLife > 24*time.Hour {
		return "", "", errors.New("invalid load name or half-life")
	}
	return strconv.FormatFloat(halfLife.Seconds(), 'f', -1, 64),
		strconv.FormatInt(int64(math.Ceil(8*halfLife.Seconds())), 10), nil
}

// AddLoad updates a distributed load in one atomic Redis operation.
func (s *Store) AddLoad(ctx context.Context, name string, amount float64, halfLife time.Duration) (float64, error) {
	if reason := classifyLoadObservation(name, amount, halfLife); reason != loadRejectionReasonNone {
		loadLog.Printf("load observation rejected reason=%s", reason)
		return 0, errors.New("invalid load observation")
	}
	seconds, ttl, err := loadArgs(name, halfLife)
	if err != nil {
		return 0, errors.New("invalid load observation")
	}
	value, err := s.Client.Do(ctx, "EVAL", loadStep, "1", s.Key("load:"+name),
		strconv.FormatFloat(amount, 'f', -1, 64), seconds, ttl)
	if err != nil {
		return 0, err
	}
	return parseLoad(value)
}

func parseLoad(value any) (float64, error) {
	number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		loadLog.Printf("load response malformed")
		return 0, errors.New("invalid load response")
	}
	return number, nil
}

// Loads reads a bounded set of counters at one Redis time without resetting
// their expiry or prolonging stale observations.
func (s *Store) Loads(ctx context.Context, names []string, halfLife time.Duration) (map[string]float64, error) {
	if len(names) == 0 || len(names) > 16 {
		return nil, errors.New("invalid load names")
	}
	seconds, _, err := loadArgs(names[0], halfLife)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(names))
	for _, name := range names {
		if !loadName.MatchString(name) {
			return nil, errors.New("invalid load name")
		}
		keys = append(keys, s.Key("load:"+name))
	}
	const script = `
local now_parts = redis.call("TIME")
local now = tonumber(now_parts[1]) + tonumber(now_parts[2]) / 1000000
local results = {}
for i, key in ipairs(KEYS) do
  local previous = redis.call("GET", key)
  local value = 0
  if previous then
    local amount, at = string.match(previous, "^([^|]+)|([^|]+)$")
    if tonumber(amount) and tonumber(at) then
      value = tonumber(amount) * math.pow(0.5, math.max(0, now - tonumber(at)) / tonumber(ARGV[1]))
    end
  end
  results[i] = tostring(value)
end
return results`
	command := append([]string{"EVAL", script, strconv.Itoa(len(keys))}, keys...)
	value, err := s.Client.Do(ctx, append(command, seconds)...)
	if err != nil {
		return nil, err
	}
	values, err := Strings(value)
	if err != nil || len(values) != len(names) {
		return nil, errors.New("invalid load response")
	}
	result := make(map[string]float64, len(names))
	for index, name := range names {
		if result[name], err = parseLoad(values[index]); err != nil {
			return nil, err
		}
	}
	return result, nil
}
