package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const DefaultMaxMemoryBytes int64 = 200_000_000

var ErrMemoryPressure = errors.New("redis memory budget exceeded after reclaiming disposable caches; scale Redis or reduce operational state")

// INFO measures the whole Redis node, including operational state and allocator
// overhead. Never change provider-owned maxmemory or evict operational keys.
const memoryPressureScript = `
local function pressure()
  local info = redis.call("INFO", "memory")
  local used = tonumber(string.match(info, "\nused_memory:(%d+)"))
  local maximum = tonumber(string.match(info, "\nmaxmemory:(%d+)"))
  if not used or not maximum then error("Redis memory statistics unavailable") end
  local budget = memory_budget
  if maximum > 0 then budget = math.min(budget, math.floor(maximum * 0.8)) end
  return used, budget
end
`

const cacheValueScript = `local memory_budget = tonumber(ARGV[3])
` + memoryPressureScript + `
local used, budget = pressure()
if used + string.len(ARGV[1]) + string.len(KEYS[1]) + 1024 > budget then return 0 end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
used, budget = pressure()
if used > budget then
  redis.call("DEL", KEYS[1])
  return 0
end
return 1
`

const memoryStatusScript = `local memory_budget = tonumber(ARGV[1])
` + memoryPressureScript + `
local used, budget = pressure()
local evicted = 0
if #KEYS == 1 and used > budget then
  evicted = redis.call("DEL", KEYS[1])
  used, budget = pressure()
end
return {used, budget, evicted}
`

type MemoryStats struct {
	UsedBytes   int64
	BudgetBytes int64
	Evicted     int64
}

func (s *Store) SetMaxMemoryBytes(maxBytes int64) error {
	if maxBytes <= 0 {
		return errors.New("redis memory budget must be a positive byte count")
	}
	s.maxMemoryBytes.Store(maxBytes)
	return nil
}

func (s *Store) MaxMemoryBytes() int64 {
	if maximum := s.maxMemoryBytes.Load(); maximum > 0 {
		return maximum
	}
	return DefaultMaxMemoryBytes
}

func (s *Store) cacheValue(ctx context.Context, key string, content []byte, ttlMilliseconds int64) error {
	if ttlMilliseconds <= 0 {
		return errors.New("cache TTL must be at least one millisecond")
	}
	if int64(len(content)) > s.MaxMemoryBytes() {
		storeLog.Printf("cache admission skipped reason=redis-memory-pressure")
		return nil
	}
	value, err := s.Client.Do(ctx, "EVAL", cacheValueScript, "1", key, string(content),
		strconv.FormatInt(ttlMilliseconds, 10), strconv.FormatInt(s.MaxMemoryBytes(), 10))
	if err != nil {
		return err
	}
	switch value {
	case int64(0):
		storeLog.Printf("cache admission skipped reason=redis-memory-pressure")
		return nil
	case int64(1):
		return nil
	default:
		return errors.New("invalid cache admission response")
	}
}

func (s *Store) memoryStats(ctx context.Context, key string) (MemoryStats, error) {
	maximum := s.MaxMemoryBytes()
	command := []string{"EVAL", memoryStatusScript, "0"}
	if key != "" {
		command[2] = "1"
		command = append(command, key)
	}
	value, err := s.Client.Do(ctx, append(command, strconv.FormatInt(maximum, 10))...)
	if err != nil {
		return MemoryStats{}, err
	}
	stats, err := decodeMemoryStats(value)
	if err != nil {
		return MemoryStats{}, err
	}
	if stats.BudgetBytes > maximum {
		return MemoryStats{}, errors.New("redis memory budget was not enforced")
	}
	return stats, nil
}

func decodeMemoryStats(value any) (MemoryStats, error) {
	values, ok := value.([]any)
	if !ok || len(values) != 3 {
		return MemoryStats{}, errors.New("invalid Redis memory response")
	}
	var numbers [3]int64
	for index := range numbers {
		number, ok := values[index].(int64)
		if !ok || number < 0 {
			return MemoryStats{}, errors.New("invalid Redis memory statistics")
		}
		numbers[index] = number
	}
	if numbers[1] <= 0 || numbers[2] > 1 {
		return MemoryStats{}, errors.New("invalid Redis memory budget or eviction count")
	}
	return MemoryStats{UsedBytes: numbers[0], BudgetBytes: numbers[1], Evicted: numbers[2]}, nil
}

var disposableCachePrefixes = []string{
	"marketplace:registry:", "repository-memory:campaign:", "repository-memory:cached-file:",
}

func (s *Store) disposableCacheKey(key, prefix string) bool {
	digest, ok := strings.CutPrefix(key, s.Key(prefix))
	return ok && validateQueryCacheKey(digest) == nil
}

// MaintainCaches reclaims only this namespace's disposable caches. Other
// namespaces and operational state can still keep the node above its budget;
// report that explicitly rather than deleting required state.
func (s *Store) MaintainCaches(ctx context.Context, maxQueryBytes int64) (MemoryStats, error) {
	_, queryStats, err := s.queryCacheCommand(ctx, "maintain", strings.Repeat("0", 64), nil, maxQueryBytes, maxQueryBytes)
	if err != nil {
		return MemoryStats{}, err
	}
	stats, err := s.memoryStats(ctx, "")
	if err != nil {
		return MemoryStats{}, err
	}
	evicted := queryStats.Evicted
	for _, prefix := range disposableCachePrefixes {
		cursor := "0"
		for stats.UsedBytes > stats.BudgetBytes {
			value, scanErr := s.Client.Do(ctx, "SCAN", cursor, "MATCH", s.Key(prefix)+"*", "COUNT", "128")
			if scanErr != nil {
				return stats, scanErr
			}
			next, keys, scanErr := decodeCacheScan(value)
			if scanErr != nil {
				return stats, scanErr
			}
			for _, key := range keys {
				if !s.disposableCacheKey(key, prefix) {
					continue
				}
				stats, err = s.memoryStats(ctx, key)
				if err != nil {
					return stats, err
				}
				evicted += stats.Evicted
				if stats.UsedBytes <= stats.BudgetBytes {
					break
				}
			}
			cursor = next
			if cursor == "0" {
				break
			}
		}
	}
	stats.Evicted = evicted
	if stats.UsedBytes > stats.BudgetBytes {
		return stats, ErrMemoryPressure
	}
	return stats, nil
}

func decodeCacheScan(value any) (string, []string, error) {
	values, ok := value.([]any)
	if !ok || len(values) != 2 {
		return "", nil, errors.New("invalid Redis cache scan response")
	}
	cursor, ok := values[0].(string)
	if !ok {
		return "", nil, errors.New("invalid Redis cache scan cursor")
	}
	if _, err := strconv.ParseUint(cursor, 10, 64); err != nil {
		return "", nil, fmt.Errorf("invalid Redis cache scan cursor: %w", err)
	}
	keys, err := Strings(values[1])
	return cursor, keys, err
}
