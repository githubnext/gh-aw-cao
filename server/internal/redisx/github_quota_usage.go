package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const (
	// GitHubQuotaUsageInterval is the width of one retained usage slot.
	GitHubQuotaUsageInterval = 15 * time.Minute
	// GitHubQuotaUsageRetention bounds how long usage slots are retained.
	GitHubQuotaUsageRetention = 24 * time.Hour
)

// GitHubQuotaUsageSample is the peak observed usage of one bucket during one
// usage slot. Used is Limit minus the lowest observed remaining quota of the
// reset window with the highest usage ratio in the slot; Reserved is the
// highest reserved capacity recorded with an observation in the slot.
type GitHubQuotaUsageSample = operational.GitHubQuotaUsageSample

// gitHubQuotaUsageScript merges one observation into a usage slot hash,
// keeping the peak usage ratio. KEYS[1] is the slot hash; ARGV is the slot
// start, limit, used, reserved, interval, retention (milliseconds), and the
// bucket field. Slots outside the retention window are ignored so a delayed
// or skewed observation cannot extend retention.
const gitHubQuotaUsageScript = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local slot = tonumber(ARGV[1])
local interval = tonumber(ARGV[5])
local retention = tonumber(ARGV[6])
if slot + interval <= now - retention or slot > now + interval then return 0 end
local limit = tonumber(ARGV[2])
local used = tonumber(ARGV[3])
local reserved = tonumber(ARGV[4])
local current = redis.call("HGET", KEYS[1], ARGV[7])
if current then
  local l, u, r = string.match(current, "^(%d+)|(%d+)|(%d+)$")
  l = tonumber(l)
  u = tonumber(u)
  r = tonumber(r)
  if l and u and r then
    if u * limit > used * l or (u * limit == used * l and u > used) then
      limit = l
      used = u
    end
    reserved = math.max(reserved, r)
  end
end
redis.call("HSET", KEYS[1], ARGV[7], string.format("%d|%d|%d", limit, used, reserved))
redis.call("PEXPIRE", KEYS[1], math.floor(slot + interval + retention - now))
return 1`

// GitHubQuotaUsageSlot returns the start of the usage slot containing at.
func GitHubQuotaUsageSlot(at time.Time) time.Time {
	return at.UTC().Truncate(GitHubQuotaUsageInterval)
}

// RecordGitHubQuotaUsage merges one bucket observation into its usage slot.
// It reports whether the slot was inside the retention window.
func (s *Store) RecordGitHubQuotaUsage(
	ctx context.Context, bucket string, at time.Time, limit, used, reserved int64,
) (bool, error) {
	if !gitHubQuotaIdentifier.MatchString(bucket) {
		return false, errors.New("github quota bucket key is invalid")
	}
	if at.IsZero() {
		return false, errors.New("github quota usage requires an observation time")
	}
	if limit < 0 || used < 0 || reserved < 0 || used > limit ||
		limit > maxGitHubQuotaCost || reserved > maxGitHubQuotaCost {
		return false, errors.New("github quota usage must be non-negative, bounded, and not exceed the limit")
	}
	slot := GitHubQuotaUsageSlot(at)
	value, err := s.Client.Do(ctx, "EVAL", gitHubQuotaUsageScript, "1", s.gitHubQuotaUsageKey(slot),
		strconv.FormatInt(slot.UnixMilli(), 10),
		strconv.FormatInt(limit, 10),
		strconv.FormatInt(used, 10),
		strconv.FormatInt(reserved, 10),
		strconv.FormatInt(GitHubQuotaUsageInterval.Milliseconds(), 10),
		strconv.FormatInt(GitHubQuotaUsageRetention.Milliseconds(), 10),
		bucket,
	)
	if err != nil {
		return false, fmt.Errorf("record Redis github quota usage: %w", err)
	}
	recorded := fmt.Sprint(value) == "1"
	gitHubQuotaLog.Printf("quota usage merged bucket=%s slot=%s recorded=%t", bucket, slot.Format(time.RFC3339), recorded)
	return recorded, nil
}

// GitHubQuotaUsage returns every retained usage sample in slot order,
// together with the Redis clock the retention window was measured from.
func (s *Store) GitHubQuotaUsage(ctx context.Context) ([]GitHubQuotaUsageSample, time.Time, error) {
	clock, err := s.Client.Do(ctx, "TIME")
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("read Redis clock: %w", err)
	}
	now, err := parseRedisTime(clock)
	if err != nil {
		return nil, time.Time{}, err
	}
	latest := GitHubQuotaUsageSlot(now)
	first := GitHubQuotaUsageSlot(now.Add(-GitHubQuotaUsageRetention)).Add(GitHubQuotaUsageInterval)
	slots := []time.Time{}
	for slot := first; !slot.After(latest); slot = slot.Add(GitHubQuotaUsageInterval) {
		slots = append(slots, slot)
	}
	commands := make([][]string, len(slots))
	for index, slot := range slots {
		commands[index] = []string{"HGETALL", s.gitHubQuotaUsageKey(slot)}
	}
	replies, err := s.Client.DoMany(ctx, commands)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("read Redis github quota usage: %w", err)
	}
	if len(replies) != len(slots) {
		return nil, time.Time{}, errors.New("redis github quota usage returned an invalid response")
	}
	samples := []GitHubQuotaUsageSample{}
	malformed := 0
	for index, reply := range replies {
		fields, err := Strings(reply)
		if err != nil {
			return nil, time.Time{}, errors.New("redis github quota usage returned an invalid response")
		}
		for field := 0; field+1 < len(fields); field += 2 {
			sample, ok := parseGitHubQuotaUsage(slots[index], fields[field], fields[field+1])
			if !ok {
				malformed++
				continue
			}
			samples = append(samples, sample)
		}
	}
	gitHubQuotaLog.Printf("quota usage read slots=%d samples=%d malformed=%d", len(slots), len(samples), malformed)
	return samples, now, nil
}

func (s *Store) gitHubQuotaUsageKey(slot time.Time) string {
	return s.Key("github:quota:usage:" + strconv.FormatInt(slot.UnixMilli(), 10))
}

func parseGitHubQuotaUsage(slot time.Time, bucket, value string) (GitHubQuotaUsageSample, bool) {
	if !gitHubQuotaIdentifier.MatchString(bucket) {
		return GitHubQuotaUsageSample{}, false
	}
	parts := strings.Split(value, "|")
	if len(parts) != 3 {
		return GitHubQuotaUsageSample{}, false
	}
	numbers := make([]int64, 3)
	for index, part := range parts {
		parsed, err := strconv.ParseInt(part, 10, 64)
		if err != nil || parsed < 0 || parsed > maxGitHubQuotaCost {
			return GitHubQuotaUsageSample{}, false
		}
		numbers[index] = parsed
	}
	if numbers[1] > numbers[0] {
		return GitHubQuotaUsageSample{}, false
	}
	return GitHubQuotaUsageSample{
		Bucket: bucket, Slot: slot, Limit: numbers[0], Used: numbers[1], Reserved: numbers[2],
	}, true
}

func parseRedisTime(value any) (time.Time, error) {
	invalid := errors.New("redis TIME returned an invalid response")
	fields, err := Strings(value)
	if err != nil || len(fields) != 2 {
		return time.Time{}, invalid
	}
	seconds, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}, invalid
	}
	micros, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil || micros < 0 || micros >= 1_000_000 {
		return time.Time{}, invalid
	}
	return time.Unix(seconds, micros*1000).UTC(), nil
}
