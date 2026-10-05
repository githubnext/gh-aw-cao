package server

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const redisMaintenanceInterval = 30 * time.Second
const redisMaintenanceTimeout = 10 * time.Second

var redisMemoryLog = logger.New("cao:server:redis-memory")

// redisMaxBytesSource identifies which input determined the resolved Redis
// memory budget. It is useful for diagnosing a misconfigured deployment
// without logging the budget value itself.
type redisMaxBytesSource string

const (
	redisMaxBytesSourceExplicit redisMaxBytesSource = "explicit"
	redisMaxBytesSourceEnv      redisMaxBytesSource = "env"
	redisMaxBytesSourceDefault  redisMaxBytesSource = "default"
)

// parseRedisMaxBytesEnv parses CAO_REDIS_MAX_BYTES' raw string value into a
// positive byte count. It is a pure function extracted from
// RedisMaxBytesFromEnv so a malformed or non-positive environment value is
// independently testable without touching the process environment.
func parseRedisMaxBytesEnv(value string) (int64, error) {
	maximum, err := strconv.ParseInt(value, 10, 64)
	if err != nil || maximum <= 0 {
		return 0, errors.New("CAO_REDIS_MAX_BYTES must be a positive byte count")
	}
	return maximum, nil
}

// RedisMaxBytesFromEnv applies the standard priority for the Redis memory
// budget: an explicit positive value, then the CAO_REDIS_MAX_BYTES
// environment variable, then redisx.DefaultMaxMemoryBytes. It logs which
// input supplied the resolved budget, never the budget value itself.
func RedisMaxBytesFromEnv(explicit int64) (int64, error) {
	if explicit < 0 {
		return 0, errors.New("redis memory budget must be a positive byte count")
	}
	if explicit > 0 {
		redisMemoryLog.Printf("redis max bytes resolved source=%s", redisMaxBytesSourceExplicit)
		return explicit, nil
	}
	if value, present := os.LookupEnv("CAO_REDIS_MAX_BYTES"); present {
		maximum, err := parseRedisMaxBytesEnv(value)
		if err != nil {
			return 0, err
		}
		redisMemoryLog.Printf("redis max bytes resolved source=%s", redisMaxBytesSourceEnv)
		return maximum, nil
	}
	redisMemoryLog.Printf("redis max bytes resolved source=%s", redisMaxBytesSourceDefault)
	return redisx.DefaultMaxMemoryBytes, nil
}

func (a *App) maintainRedisCaches(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, redisMaintenanceTimeout)
	defer cancel()
	stats, err := a.store.MaintainCaches(ctx, a.config.QueryCache.MaxBytes)
	if errors.Is(err, redisx.ErrMemoryPressure) {
		a.config.Logger.Printf("Redis node-wide memory pressure used_bytes=%d budget_bytes=%d disposable_cache_entries_evicted=%d action=inspect_provider_memory_and_namespace_key_families_then_scale_redis_and_synchronize_CAO_REDIS_MAX_BYTES",
			stats.UsedBytes, stats.BudgetBytes, stats.Evicted)
	}
	if err != nil {
		return err
	}
	if stats.Evicted > 0 {
		a.config.Logger.Printf("Redis cache maintenance evicted=%d used_bytes=%d budget_bytes=%d",
			stats.Evicted, stats.UsedBytes, stats.BudgetBytes)
	}
	return nil
}

func (a *App) runRedisMaintenance(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.maintainRedisCaches(ctx); err != nil && ctx.Err() == nil {
				// Do not log raw Redis errors, which can include internal keys.
				a.config.Logger.Printf("Redis cache maintenance failed memory_pressure=%t",
					errors.Is(err, redisx.ErrMemoryPressure))
			}
		}
	}
}

func (a *App) initializeRedisMaintenance(ctx context.Context) error {
	if a.store == nil {
		return nil
	}
	err := a.maintainRedisCaches(ctx)
	if (err == nil || errors.Is(err, redisx.ErrMemoryPressure)) && !a.store.DisposableCachesEnabled() {
		a.config.Logger.Printf("Redis disposable caching disabled reason=atomic-memory-introspection-unsupported; protected storage remains enabled")
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, redisx.ErrMemoryPressure) {
			return err
		}
		return errors.New("redis cache maintenance is unavailable")
	}
	return nil
}
