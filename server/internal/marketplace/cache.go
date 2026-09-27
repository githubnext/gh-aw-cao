package marketplace

import (
	"context"
	"encoding/json"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var cacheLog = logger.New("cao:marketplace:cache")

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

// cacheMissReason identifies why loadCachedRegistry treated a lookup as a
// miss. It is useful for diagnosing a caching problem (versus an ordinary
// cold cache) without logging the registry id, generation, or cached bytes
// themselves.
type cacheMissReason string

const (
	cacheMissReasonNone      cacheMissReason = ""
	cacheMissReasonNotFound  cacheMissReason = "not-found"
	cacheMissReasonReadError cacheMissReason = "read-error"
)

// classifyCacheLookup inspects the outcome of a Cache.Get call and decides
// which cacheMissReason applies, or cacheMissReasonNone for a usable hit. It
// is a pure function so the miss-classification rules are testable without a
// real or fake Cache.
func classifyCacheLookup(data []byte, hit bool, err error) cacheMissReason {
	if err != nil {
		return cacheMissReasonReadError
	}
	if !hit || len(data) == 0 {
		return cacheMissReasonNotFound
	}
	return cacheMissReasonNone
}

// loadCachedRegistry returns a previously cached, still-safe package list. Any
// cache error or corrupt payload is treated as a miss so a caching problem
// never blocks resolution.
func loadCachedRegistry(ctx context.Context, cache Cache, registryID, generation string) ([]Package, bool) {
	if cache == nil {
		return nil, false
	}
	data, hit, err := cache.Get(ctx, registryID, generation)
	switch classifyCacheLookup(data, hit, err) {
	case cacheMissReasonReadError:
		cacheLog.Printf("registry cache lookup failed; treating as miss")
		return nil, false
	case cacheMissReasonNotFound:
		return nil, false
	}
	var payload cachedRegistryPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		cacheLog.Printf("registry cache payload was corrupt; treating as miss")
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
		cacheLog.Printf("registry cache encode failed; not caching")
		return
	}
	if err := cache.Set(ctx, registryID, generation, data, ttl); err != nil {
		cacheLog.Printf("registry cache write failed")
	}
}
