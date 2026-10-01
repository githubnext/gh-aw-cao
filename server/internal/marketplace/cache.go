package marketplace

import (
	"context"
	"encoding/json"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var cacheLog = logger.New("cao:marketplace:cache")

// Cache isolates registry results by registry id and by dataRevision (the
// dashboard's active data revision), so a cache entry from one revision or
// registry can never be served for another. Implementations only ever store
// the safe, normalized Package DTO — never tokens or secret values.
type Cache interface {
	// Get returns the cached bytes for (registryID, dataRevision) and whether an
	// entry was present. A miss (hit == false) must not be treated as an error.
	Get(ctx context.Context, registryID, dataRevision string) (data []byte, hit bool, err error)
	// Set stores data for (registryID, dataRevision) with the given TTL.
	Set(ctx context.Context, registryID, dataRevision string, data []byte, ttl time.Duration) error
}

type cachedRegistryPayload struct {
	Packages []Package `json:"packages"`
}

// decodeCachedRegistryPayload decodes a cache entry's raw bytes into a
// package list. It is split out from loadCachedRegistry as a pure function so
// the "corrupt payload is a miss, not an error" rule is directly testable
// without a Cache double.
func decodeCachedRegistryPayload(data []byte) ([]Package, bool) {
	if len(data) == 0 {
		return nil, false
	}
	var payload cachedRegistryPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false
	}
	return payload.Packages, true
}

// loadCachedRegistry returns a previously cached, still-safe package list. Any
// cache error or corrupt payload is treated as a miss so a caching problem
// never blocks resolution.
func loadCachedRegistry(ctx context.Context, cache Cache, registryID, dataRevision string) ([]Package, bool) {
	if cache == nil {
		return nil, false
	}
	data, hit, err := cache.Get(ctx, registryID, dataRevision)
	if err != nil {
		// A cache backend failure must never block resolution, but it is
		// still worth distinguishing from an ordinary miss when diagnosing
		// why a deployment always resolves against the live registry.
		cacheLog.Printf("cache read failed, treating as miss")
		return nil, false
	}
	if !hit {
		return nil, false
	}
	packages, ok := decodeCachedRegistryPayload(data)
	if !ok {
		cacheLog.Printf("cache payload was not decodable, treating as miss")
		return nil, false
	}
	return packages, true
}

// storeCachedRegistry best-effort caches a resolved registry's packages. A
// write failure is not fatal to the caller: the result is still returned to
// the client, just not cached for the next request.
func storeCachedRegistry(ctx context.Context, cache Cache, registryID, dataRevision string, ttl time.Duration, packages []Package) {
	if cache == nil {
		return
	}
	data, err := json.Marshal(cachedRegistryPayload{Packages: packages})
	if err != nil {
		return
	}
	if err := cache.Set(ctx, registryID, dataRevision, data, ttl); err != nil {
		cacheLog.Printf("cache write failed, resolution result was not cached")
	}
}
