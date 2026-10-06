package redisx

import (
	"context"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var queryCacheLog = logger.New("cao:redis:querycache")

const (
	QueryCacheTTL        = 5 * time.Minute
	QueryCacheMaxEntries = 1024
)

type QueryCacheStats = operational.QueryCacheStats

// The hash and expiration index form a portable per-entry TTL cache. All
// bookkeeping and oldest-first eviction share one atomic operation.
const queryCacheScript = `local memory_budget = tonumber(ARGV[8])
` + memoryPressureScript + `
local entries, index = KEYS[1], KEYS[2]
if redis.call("EXISTS", entries) ~= redis.call("EXISTS", index) then
  redis.call("DEL", entries, index)
end
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl, budget, max_entries = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local expired, evicted = 0, 0
local function remove(key)
  redis.call("HDEL", entries, key)
  redis.call("ZREM", index, key)
end
for _, key in ipairs(redis.call("ZRANGEBYSCORE", index, "-inf", now)) do
  remove(key)
  expired = expired + 1
end
local function memory(key)
  return redis.call("MEMORY", "USAGE", key, "SAMPLES", 0) or 0
end
local cache_bytes, cache_count = 0, 0
local function trim(reserve, outgoing)
  local global_reserve = reserve + (outgoing or 0)
  cache_count = redis.call("ZCARD", index)
  cache_bytes = memory(entries) + memory(index)
  local used, global_budget = pressure()
  while cache_count > 0 and (cache_count > max_entries or cache_bytes + reserve > budget or used + global_reserve > global_budget) do
    local batch = math.max(1, cache_count - max_entries)
    local excess = math.max(cache_bytes + reserve - budget, used + global_reserve - global_budget)
    if excess > 0 and cache_bytes > 0 then
      batch = math.max(batch, math.ceil(cache_count * excess / cache_bytes))
    end
    local oldest = redis.call("ZRANGE", index, 0, math.min(batch, cache_count) - 1)
    for _, key in ipairs(oldest) do
      remove(key)
      evicted = evicted + 1
    end
    cache_count = cache_count - #oldest
    cache_bytes = memory(entries) + memory(index)
    used, global_budget = pressure()
  end
  if cache_count == 0 then
    redis.call("DEL", entries, index)
    cache_bytes = 0
    used, global_budget = pressure()
  end
  return used + global_reserve <= global_budget and cache_bytes + reserve <= budget
end
local function reply(value)
  return {value, cache_bytes, cache_count, expired, evicted}
end
if ARGV[1] == "maintain" then
  trim(0)
  return reply(false)
end
local length = redis.call("HSTRLEN", entries, ARGV[5])
if length > tonumber(ARGV[7]) then
  remove(ARGV[5])
  evicted = evicted + 1
end
local present = redis.call("HEXISTS", entries, ARGV[5]) == 1
if present and not redis.call("ZSCORE", index, ARGV[5]) then
  remove(ARGV[5])
  present = false
end
if ARGV[1] == "get" then
  local safe = trim(0, present and outgoing_reserve(length) or 0)
  if not safe or redis.call("HEXISTS", entries, ARGV[5]) == 0 then return reply(false) end
  return reply(redis.call("HGET", entries, ARGV[5]))
end
if not present then
  if not trim(string.len(ARGV[6]) + string.len(ARGV[5]) + 1024) then return reply(0) end
  redis.call("HSET", entries, ARGV[5], ARGV[6])
  redis.call("ZADD", index, now + ttl, ARGV[5])
  redis.call("PEXPIRE", entries, ttl)
  redis.call("PEXPIRE", index, ttl)
end
trim(0)
return reply(redis.call("HEXISTS", entries, ARGV[5]))
`

func validateQueryCacheKey(key string) error {
	decoded, err := hex.DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return errors.New("query cache identity must be a SHA-256 digest")
	}
	return nil
}

// decodeQueryCacheReply parses the raw EVAL reply shared by every query
// cache operation into its payload value and bookkeeping statistics. It is a
// pure function so each malformed-reply shape (wrong arity, non-integer
// statistics, a negative count, or resource limits the script failed to
// enforce) is unit-testable without a Redis server or client double.
func decodeQueryCacheReply(value any, maxBytes int64) (any, QueryCacheStats, error) {
	values, ok := value.([]any)
	if !ok || len(values) != 5 {
		return nil, QueryCacheStats{}, errors.New("invalid query cache operation response")
	}
	var numbers [4]int64
	for i := range numbers {
		number, ok := values[i+1].(int64)
		if !ok || number < 0 {
			return nil, QueryCacheStats{}, errors.New("invalid query cache statistics")
		}
		numbers[i] = number
	}
	if numbers[0] > maxBytes || numbers[1] > QueryCacheMaxEntries {
		return nil, QueryCacheStats{}, errors.New("query cache resource limits were not enforced")
	}
	return values[0], QueryCacheStats{
		MemoryBytes: numbers[0], Entries: numbers[1], Expired: numbers[2], Evicted: numbers[3],
	}, nil
}

func (s *Store) queryCacheCommand(ctx context.Context, operation, key string, data []byte, maxResultBytes, maxBytes int64) (any, QueryCacheStats, error) {
	if err := validateQueryCacheKey(key); err != nil {
		return nil, QueryCacheStats{}, err
	}
	if maxResultBytes <= 0 || maxBytes <= 0 {
		return nil, QueryCacheStats{}, errors.New("query cache size limits must be positive")
	}
	if err := s.InitializeDisposableCaches(ctx); err != nil {
		return nil, QueryCacheStats{}, err
	}
	if !s.DisposableCachesEnabled() {
		if operation == "put" {
			return int64(0), QueryCacheStats{}, nil
		}
		return nil, QueryCacheStats{}, nil
	}
	// The hash tag keeps all keys in one slot on clustered Redis providers.
	keys := s.queryCacheKeys()
	value, err := s.Client.Do(ctx, "EVAL", queryCacheScript, "2",
		keys[0], keys[1],
		operation, strconv.FormatInt(QueryCacheTTL.Milliseconds(), 10),
		strconv.FormatInt(maxBytes, 10), strconv.Itoa(QueryCacheMaxEntries), key, string(data),
		strconv.FormatInt(maxResultBytes, 10), strconv.FormatInt(s.MaxMemoryBytes(), 10))
	if err != nil {
		return nil, QueryCacheStats{}, err
	}
	result, stats, err := decodeQueryCacheReply(value, maxBytes)
	if err != nil {
		return nil, QueryCacheStats{}, err
	}
	if stats.Expired > 0 || stats.Evicted > 0 {
		queryCacheLog.Printf("query cache maintenance operation=%s expired=%d evicted=%d entries=%d",
			operation, stats.Expired, stats.Evicted, stats.Entries)
	}
	return result, stats, nil
}

func (s *Store) queryCacheKeys() [2]string {
	prefix := s.Key("{query-cache:v1}:")
	return [2]string{prefix + "entries", prefix + "expiry"}
}

func (s *Store) CachedQueryResult(ctx context.Context, key string, maxResultBytes, maxBytes int64) ([]byte, QueryCacheStats, error) {
	value, stats, err := s.queryCacheCommand(ctx, "get", key, nil, maxResultBytes, maxBytes)
	if err != nil || value == nil {
		return nil, stats, err
	}
	content, ok := value.(string)
	if !ok {
		return nil, stats, errors.New("invalid query cache response")
	}
	if int64(len(content)) > maxResultBytes {
		return nil, stats, errors.New("cached query result exceeds the configured size limit")
	}
	return []byte(content), stats, nil
}

func (s *Store) CacheQueryResult(ctx context.Context, key string, data []byte, maxResultBytes, maxBytes int64) (bool, QueryCacheStats, error) {
	if err := validateQueryCacheKey(key); err != nil {
		return false, QueryCacheStats{}, err
	}
	if maxResultBytes <= 0 || maxBytes <= 0 {
		return false, QueryCacheStats{}, errors.New("query cache size limits must be positive")
	}
	if int64(len(data)) > maxResultBytes || int64(len(data)) > maxBytes || int64(len(data)) > s.MaxMemoryBytes() {
		return false, QueryCacheStats{}, nil
	}
	value, stats, err := s.queryCacheCommand(ctx, "put", key, data, maxResultBytes, maxBytes)
	if err != nil {
		return false, stats, err
	}
	switch value {
	case int64(0):
		return false, stats, nil
	case int64(1):
		return true, stats, nil
	default:
		return false, stats, errors.New("invalid query cache admission response")
	}
}
