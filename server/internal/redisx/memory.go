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

const cacheCapabilityScript = `
local function probe(...)
  local result = redis.pcall(...)
  if type(result) == "table" and result.err then return {0, result.err} end
  return {1, result or false}
end
return {probe("INFO", "memory"), probe("MEMORY", "USAGE", KEYS[1], "SAMPLES", 0)}
`

// INFO measures the whole Redis node, including operational state and allocator
// overhead. Never change provider-owned maxmemory or evict operational keys.
const memoryPressureScript = `
local function pressure()
  local info = redis.call("INFO", "memory")
  local used = tonumber(string.match(info, "\nused_memory:(%d+)"))
  local maximum = tonumber(string.match(info, "\nmaxmemory:(%d+)"))
  if not used or not maximum then error("Redis memory statistics unavailable") end
  local budget = memory_budget
  if maximum > 0 then
    budget = math.min(budget, math.floor(maximum / 5) * 4 + math.floor((maximum % 5) * 4 / 5))
  end
  if budget <= 0 then error("Invalid Redis memory budget") end
  return used, budget
end
local function outgoing_reserve(length)
  -- Allow for response-buffer allocator rounding and protocol/chunk overhead.
  return length * 2 + 65536
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

const cachedValueScript = `local memory_budget = tonumber(ARGV[1])
` + memoryPressureScript + `
local length = redis.call("STRLEN", KEYS[1])
if length == 0 and redis.call("EXISTS", KEYS[1]) == 0 then return false end
local used, budget = pressure()
if used + outgoing_reserve(length) > budget then return false end
return redis.call("GET", KEYS[1])
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

// DisposableCachesEnabled is false until capability initialization succeeds.
func (s *Store) DisposableCachesEnabled() bool {
	return s.cacheCapability.Load() == 1
}

// InitializeDisposableCaches disables optional caches for unsupported script
// introspection or an unreported scripted quota. Invalid statistics still fail.
func (s *Store) InitializeDisposableCaches(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.cacheCapability.Load() != 0 {
		return nil
	}
	s.cacheInitMu.Lock()
	defer s.cacheInitMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.cacheCapability.Load() != 0 {
		return nil
	}
	if _, err := s.sampleMemory(ctx); err != nil {
		return err
	}
	value, err := s.Client.Do(ctx, "EVAL", cacheCapabilityScript, "1", s.queryCacheKeys()[0])
	if err != nil {
		return err
	}
	probes, ok := value.([]any)
	if !ok || len(probes) != 2 {
		return errors.New("invalid Redis cache capability response")
	}
	enabled := true
	for index, probe := range probes {
		fields, ok := probe.([]any)
		if !ok || len(fields) != 2 {
			return errors.New("invalid Redis cache capability response")
		}
		status, ok := fields[0].(int64)
		if !ok {
			return errors.New("invalid Redis cache capability status")
		}
		switch status {
		case 0:
			message, ok := fields[1].(string)
			if !ok || !unsupportedScriptIntrospection(message, index) {
				return errors.New("redis cache introspection probe failed")
			}
			enabled = false
		case 1:
			if index == 0 {
				_, quotaReported, err := s.parseMemoryInfoWithQuota(fields[1])
				if err != nil {
					return err
				}
				if !quotaReported {
					enabled = false
				}
			} else if fields[1] != nil {
				if usage, ok := fields[1].(int64); !ok || usage < 0 {
					return errors.New("invalid Redis memory usage probe")
				}
			}
		default:
			return errors.New("invalid Redis cache capability status")
		}
	}
	if enabled {
		s.cacheCapability.Store(1)
	} else {
		s.cacheCapability.Store(2)
	}
	return nil
}

func unsupportedScriptIntrospection(message string, probe int) bool {
	message = strings.ToLower(message)
	for _, reason := range []string{
		"command is not allowed from script", "command is not allowed in script",
		"not supported for scripts", "not supported in scripts", "not supported in lua",
	} {
		if strings.Contains(message, reason) {
			return true
		}
	}
	command := "info"
	if probe == 1 {
		command = "memory"
	}
	return strings.HasPrefix(message, "err unknown command") && strings.Contains(message, "'"+command+"'") ||
		probe == 1 && strings.HasPrefix(message, "err unknown subcommand") && strings.Contains(message, "'usage'")
}

func (s *Store) cacheValue(ctx context.Context, key string, content []byte, ttlMilliseconds int64) error {
	if ttlMilliseconds <= 0 {
		return errors.New("cache TTL must be at least one millisecond")
	}
	if int64(len(content)) > s.MaxMemoryBytes() {
		storeLog.Printf("cache admission skipped reason=redis-memory-pressure")
		return nil
	}
	if err := s.InitializeDisposableCaches(ctx); err != nil {
		return err
	}
	if !s.DisposableCachesEnabled() {
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

func (s *Store) cachedValue(ctx context.Context, key string) ([]byte, error) {
	if err := s.InitializeDisposableCaches(ctx); err != nil {
		return nil, err
	}
	if !s.DisposableCachesEnabled() {
		return nil, nil
	}
	value, err := s.Client.Do(ctx, "EVAL", cachedValueScript, "1", key, strconv.FormatInt(s.MaxMemoryBytes(), 10))
	if err != nil || value == nil {
		return nil, err
	}
	content, ok := value.(string)
	if !ok {
		return nil, errors.New("invalid cached value response")
	}
	return []byte(content), nil
}

func (s *Store) sampleMemory(ctx context.Context) (MemoryStats, error) {
	value, err := s.Client.Do(ctx, "INFO", "memory")
	if err != nil {
		return MemoryStats{}, err
	}
	return s.parseMemoryInfo(value)
}

func (s *Store) parseMemoryInfo(value any) (MemoryStats, error) {
	stats, _, err := s.parseMemoryInfoWithQuota(value)
	return stats, err
}

func (s *Store) parseMemoryInfoWithQuota(value any) (MemoryStats, bool, error) {
	info, ok := value.(string)
	if !ok {
		return MemoryStats{}, false, errors.New("invalid Redis memory INFO response")
	}
	var used, maximum int64
	var haveUsed, haveMaximum bool
	for _, line := range strings.Split(info, "\n") {
		name, value, _ := strings.Cut(strings.TrimSuffix(line, "\r"), ":")
		if name != "used_memory" && name != "maxmemory" {
			continue
		}
		number, err := strconv.ParseUint(value, 10, 63)
		if err != nil || value == "" || strings.HasPrefix(value, "+") {
			return MemoryStats{}, false, errors.New("invalid Redis memory INFO statistic")
		}
		if name == "used_memory" {
			if haveUsed {
				return MemoryStats{}, false, errors.New("duplicate Redis memory INFO statistic")
			}
			used, haveUsed = int64(number), true
		} else {
			if haveMaximum {
				return MemoryStats{}, false, errors.New("duplicate Redis memory INFO statistic")
			}
			maximum, haveMaximum = int64(number), true
		}
	}
	if !haveUsed {
		return MemoryStats{}, false, errors.New("redis memory INFO statistics unavailable")
	}
	// An unknown provider quota leaves the explicit finite budget in force;
	// only a reported quota can apply provider clamping.
	budget := s.MaxMemoryBytes()
	if haveMaximum {
		var err error
		budget, err = s.EffectiveMaxMemoryBytes(maximum)
		if err != nil {
			return MemoryStats{}, true, err
		}
	}
	return MemoryStats{UsedBytes: used, BudgetBytes: budget}, haveMaximum, nil
}

func (s *Store) memoryStats(ctx context.Context, key string) (MemoryStats, error) {
	stats, err := s.sampleMemory(ctx)
	if err != nil {
		return MemoryStats{}, err
	}
	if key == "" || stats.UsedBytes <= stats.BudgetBytes {
		return stats, nil
	}
	if !s.disposableKey(key) {
		return stats, errors.New("refusing to reclaim a non-disposable Redis key")
	}
	value, err := s.Client.Do(ctx, "DEL", key)
	if err != nil {
		return stats, err
	}
	evicted, ok := value.(int64)
	if !ok || evicted < 0 || evicted > 1 {
		return stats, errors.New("invalid Redis cache deletion response")
	}
	stats, err = s.sampleMemory(ctx)
	stats.Evicted = evicted
	return stats, err
}

var disposableCachePrefixes = []string{
	"marketplace:registry:", "repository-memory:campaign:", "repository-memory:cached-file:",
}

func (s *Store) disposableCacheKey(key, prefix string) bool {
	digest, ok := strings.CutPrefix(key, s.Key(prefix))
	return ok && validateQueryCacheKey(digest) == nil
}

func (s *Store) disposableKey(key string) bool {
	for _, queryKey := range s.queryCacheKeys() {
		if key == queryKey {
			return true
		}
	}
	for _, prefix := range disposableCachePrefixes {
		if s.disposableCacheKey(key, prefix) {
			return true
		}
	}
	return false
}

// MaintainCaches reclaims only this namespace's disposable caches. Other
// namespaces and operational state can still keep the node above its budget;
// report that explicitly rather than deleting required state.
func (s *Store) MaintainCaches(ctx context.Context, maxQueryBytes int64) (MemoryStats, error) {
	if maxQueryBytes <= 0 {
		return MemoryStats{}, errors.New("query cache size limits must be positive")
	}
	if err := s.InitializeDisposableCaches(ctx); err != nil {
		return MemoryStats{}, err
	}
	stats, err := s.sampleMemory(ctx)
	if err != nil {
		return MemoryStats{}, err
	}
	var evicted int64
	if s.DisposableCachesEnabled() {
		_, queryStats, err := s.queryCacheCommand(ctx, "maintain", strings.Repeat("0", 64), nil, maxQueryBytes, maxQueryBytes)
		if err != nil {
			return stats, err
		}
		evicted = queryStats.Evicted
	} else {
		// Disabled caches are never served; remove their old query containers
		// without requiring either introspection command inside Lua.
		keys := s.queryCacheKeys()
		value, err := s.Client.Do(ctx, "DEL", keys[0], keys[1])
		if err != nil {
			return stats, err
		}
		count, ok := value.(int64)
		if !ok || count < 0 || count > 2 {
			return stats, errors.New("invalid Redis query cache deletion response")
		}
		evicted = count
	}
	stats, err = s.sampleMemory(ctx)
	if err != nil {
		return stats, err
	}
	cursor := "0"
	for stats.UsedBytes > stats.BudgetBytes {
		value, scanErr := s.Client.Do(ctx, "SCAN", cursor, "MATCH", s.Key("*"), "COUNT", "1024")
		if scanErr != nil {
			return stats, scanErr
		}
		next, keys, scanErr := decodeCacheScan(value)
		if scanErr != nil {
			return stats, scanErr
		}
		stats, err = s.sampleMemory(ctx)
		if err != nil {
			return stats, err
		}
		for _, key := range keys {
			if stats.UsedBytes <= stats.BudgetBytes {
				break
			}
			if !s.disposableKey(key) {
				continue
			}
			stats, err = s.memoryStats(ctx, key)
			evicted += stats.Evicted
			if err != nil {
				return stats, err
			}
		}
		cursor = next
		if cursor == "0" {
			break
		}
	}
	stats, err = s.sampleMemory(ctx)
	stats.Evicted = evicted
	if err != nil {
		return stats, err
	}
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
