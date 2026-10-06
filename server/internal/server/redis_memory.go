package server

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
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
	err := a.store.Maintain(ctx)
	var pressure *operational.MaintenanceError
	if errors.As(err, &pressure) {
		a.config.Logger.Printf("Operational cache maintenance pressure used_bytes=%d budget_bytes=%d disposable_cache_entries_evicted=%d action=inspect_operational_backend_capacity_and_preserve_protected_state",
			pressure.UsedBytes, pressure.BudgetBytes, pressure.Evicted)
	}
	if err == nil {
		health, healthErr := a.store.Health(ctx)
		if healthErr != nil {
			return healthErr
		}
		if health.CacheDisabled {
			a.config.Logger.Printf("Operational disposable caching disabled; protected storage remains enabled")
		}
	}
	return err
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
				a.config.Logger.Printf("Operational cache maintenance failed")
			}
		}
	}
}

func (a *App) initializeRedisMaintenance(ctx context.Context) error {
	if a.store == nil {
		return nil
	}
	err := a.maintainRedisCaches(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var pressure *operational.MaintenanceError
		if errors.As(err, &pressure) {
			return err
		}
		return errors.New("operational cache maintenance is unavailable")
	}
	return nil
}
