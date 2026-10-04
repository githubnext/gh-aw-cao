package server

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const redisMaintenanceInterval = 30 * time.Second
const redisMaintenanceTimeout = 10 * time.Second

func RedisMaxBytesFromEnv(explicit int64) (int64, error) {
	if explicit < 0 {
		return 0, errors.New("redis memory budget must be a positive byte count")
	}
	if explicit > 0 {
		return explicit, nil
	}
	if value, present := os.LookupEnv("CAO_REDIS_MAX_BYTES"); present {
		maximum, err := strconv.ParseInt(value, 10, 64)
		if err != nil || maximum <= 0 {
			return 0, errors.New("CAO_REDIS_MAX_BYTES must be a positive byte count")
		}
		return maximum, nil
	}
	return redisx.DefaultMaxMemoryBytes, nil
}

func (a *App) maintainRedisCaches(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, redisMaintenanceTimeout)
	defer cancel()
	stats, err := a.store.MaintainCaches(ctx, a.config.QueryCache.MaxBytes)
	if errors.Is(err, redisx.ErrMemoryPressure) {
		a.config.Logger.Printf("Redis memory pressure used_bytes=%d budget_bytes=%d evicted=%d",
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
