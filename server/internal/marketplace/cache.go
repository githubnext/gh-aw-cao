package marketplace

import (
	"context"
	"encoding/json"
	"time"
)

// Cache isolates registry results by registry id and by generation (the
// dashboard's active data revision), so a cache entry from one revision or
// registry can never be served for another. Implementations only ever store
// the safe, normalized Package DTO — never tokens or secret values.
type Cache interface {
	// Get returns the cached bytes for (registryID, generation) and whether an
	// entry was present. A miss (hit == false) must not be treated as an error.
	Get(ctx context.Context, registryID, generation string) (data []byte, hit bool, err error)
	// Set stores data for (registryID, generation) with the given TTL.
	Set(ctx context.Context, registryID, generation string, data []byte, ttl time.Duration) error
}

type cachedRegistryPayload struct {
	Packages []Package `json:"packages"`
}

// loadCachedRegistry returns a previously cached, still-safe package list. Any
// cache error or corrupt payload is treated as a miss so a caching problem
// never blocks resolution.
func loadCachedRegistry(ctx context.Context, cache Cache, registryID, generation string) ([]Package, bool) {
	if cache == nil {
		return nil, false
	}
	data, hit, err := cache.Get(ctx, registryID, generation)
	if err != nil || !hit || len(data) == 0 {
		return nil, false
	}
	var payload cachedRegistryPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false
	}
	return payload.Packages, true
}

// storeCachedRegistry best-effort caches a resolved registry's packages. A
// write failure is not fatal to the caller: the result is still returned to
// the client, just not cached for the next request.
func storeCachedRegistry(ctx context.Context, cache Cache, registryID, generation string, ttl time.Duration, packages []Package) {
	if cache == nil {
		return
	}
	data, err := json.Marshal(cachedRegistryPayload{Packages: packages})
	if err != nil {
		return
	}
	_ = cache.Set(ctx, registryID, generation, data, ttl)
}
