package memory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type cacheEntry struct {
	data    []byte
	expires time.Time
	order   uint64
	query   bool
	bytes   int64
}

func cacheKey(kind string, parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return kind + ":" + hex.EncodeToString(h.Sum(nil))
}

func (s *Store) removeCache(key string) {
	s.cacheBytes -= s.cache[key].bytes
	delete(s.cache, key)
}

func (s *Store) expireCache(now time.Time) int64 {
	var queries int64
	for k, v := range s.cache {
		if !v.expires.After(now) {
			if v.query {
				queries++
			}
			s.removeCache(k)
		}
	}
	return queries
}

func (s *Store) queryStats(expired, evicted int64) operational.QueryCacheStats {
	st := operational.QueryCacheStats{Expired: expired, Evicted: evicted}
	for _, v := range s.cache {
		if v.query {
			st.Entries++
			st.MemoryBytes += v.bytes
		}
	}
	return st
}

func (s *Store) oldestCache(queryOnly bool) string {
	var oldest string
	var order uint64
	for k, v := range s.cache {
		if queryOnly && !v.query {
			continue
		}
		if oldest == "" || v.order < order {
			oldest, order = k, v.order
		}
	}
	return oldest
}

func (s *Store) trimQueries(reserve int64, maxBytes int64, newEntry bool) int64 {
	var evicted int64
	for {
		st := s.queryStats(0, 0)
		count := st.Entries
		if newEntry {
			count++
		}
		if st.MemoryBytes+reserve <= maxBytes && count <= operational.QueryCacheMaxEntries {
			break
		}
		key := s.oldestCache(true)
		if key == "" {
			break
		}
		s.removeCache(key)
		evicted++
	}
	return evicted
}

func (s *Store) trimCache(reserve int64, newEntry bool) int64 {
	var queryEvicted int64
	for {
		count := len(s.cache)
		if newEntry {
			count++
		}
		if count <= s.config.MaxCacheEntries && s.cacheBytes+reserve <= s.config.MaxCacheBytes {
			break
		}
		key := s.oldestCache(false)
		if key == "" {
			break
		}
		if s.cache[key].query {
			queryEvicted++
		}
		s.removeCache(key)
	}
	return queryEvicted
}

func queryKey(key string) (string, error) {
	digest, err := hex.DecodeString(key)
	if err != nil || len(digest) != sha256.Size {
		return "", invalid("query identity must be a SHA-256 digest")
	}
	return "query:" + strings.ToLower(key), nil
}

func (s *Store) CachedQueryResult(ctx context.Context, key string, maxResultBytes, maxBytes int64) ([]byte, operational.QueryCacheStats, error) {
	if err := s.enter(ctx); err != nil {
		return nil, operational.QueryCacheStats{}, err
	}
	defer s.mu.Unlock()
	key, err := queryKey(key)
	if err != nil {
		return nil, operational.QueryCacheStats{}, err
	}
	if maxResultBytes <= 0 || maxBytes <= 0 {
		return nil, operational.QueryCacheStats{}, invalid("query limits must be positive")
	}
	expired := s.expireCache(s.config.Clock())
	evicted := s.trimQueries(0, maxBytes, false)
	if v, ok := s.cache[key]; ok && int64(len(v.data)) > maxResultBytes {
		s.removeCache(key)
		evicted++
	}
	v, exists := s.cache[key]
	if !exists {
		return nil, s.queryStats(expired, evicted), nil
	}
	return clonePresent(v.data), s.queryStats(expired, evicted), nil
}

func (s *Store) CacheQueryResult(ctx context.Context, key string, data []byte, maxResultBytes, maxBytes int64) (bool, operational.QueryCacheStats, error) {
	if err := s.enter(ctx); err != nil {
		return false, operational.QueryCacheStats{}, err
	}
	defer s.mu.Unlock()
	key, err := queryKey(key)
	if err != nil {
		return false, operational.QueryCacheStats{}, err
	}
	if maxResultBytes <= 0 || maxBytes <= 0 {
		return false, operational.QueryCacheStats{}, invalid("query limits must be positive")
	}
	now := s.config.Clock()
	expired := s.expireCache(now)
	size := charge(key) + int64(len(data))
	if int64(len(data)) > maxResultBytes || int64(len(data)) > s.config.MaxCacheValueBytes ||
		size > maxBytes || size > s.config.MaxCacheBytes {
		return false, s.queryStats(expired, 0), nil
	}
	var evicted int64
	if v, ok := s.cache[key]; ok && int64(len(v.data)) > maxResultBytes {
		s.removeCache(key)
		evicted++
	}
	_, present := s.cache[key]
	if present {
		evicted += s.trimQueries(0, maxBytes, false)
		_, present = s.cache[key]
		return present, s.queryStats(expired, evicted), nil
	}
	evicted += s.trimQueries(size, maxBytes, true)
	evicted += s.trimCache(size, true)
	s.seq++
	s.cache[key] = cacheEntry{data: bytes.Clone(data), expires: now.Add(operational.QueryCacheTTL),
		order: s.seq, query: true, bytes: size}
	s.cacheBytes += size
	return true, s.queryStats(expired, evicted), nil
}

func (s *Store) cached(ctx context.Context, kind string, parts ...string) ([]byte, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	if err := s.name(parts...); err != nil {
		return nil, err
	}
	s.expireCache(s.config.Clock())
	v, exists := s.cache[cacheKey(kind, parts...)]
	if !exists {
		return nil, nil
	}
	return clonePresent(v.data), nil
}

func clonePresent(data []byte) []byte {
	result := make([]byte, len(data))
	copy(result, data)
	return result
}

// These caches accept already-normalized, safe-to-serve bytes. Normalization
// belongs to the marketplace/repository consumer, not to operational storage.
func (s *Store) cacheValue(ctx context.Context, kind string, data []byte, ttl time.Duration, parts ...string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(parts...); err != nil {
		return err
	}
	if err := validTTL(ttl); err != nil {
		return err
	}
	key := cacheKey(kind, parts...)
	size := charge(key) + int64(len(data))
	if int64(len(data)) > s.config.MaxCacheValueBytes || size > s.config.MaxCacheBytes {
		return capacity()
	}
	now := s.config.Clock()
	s.expireCache(now)
	if _, ok := s.cache[key]; ok {
		s.removeCache(key)
	}
	s.trimCache(size, true)
	s.seq++
	s.cache[key] = cacheEntry{data: bytes.Clone(data), expires: now.Add(ttl), order: s.seq, bytes: size}
	s.cacheBytes += size
	return nil
}

func (s *Store) CachedMarketplaceRegistry(ctx context.Context, id, generation string) ([]byte, error) {
	return s.cached(ctx, "marketplace", id, generation)
}

func (s *Store) CacheMarketplaceRegistry(ctx context.Context, id, generation string, data []byte, ttl time.Duration) error {
	return s.cacheValue(ctx, "marketplace", data, ttl, id, generation)
}

func (s *Store) CachedRepositoryMemoryCampaign(ctx context.Context, campaign string) ([]byte, error) {
	return s.cached(ctx, "campaign", campaign)
}

func (s *Store) CacheRepositoryMemoryCampaign(ctx context.Context, campaign string, data []byte, ttl time.Duration) error {
	return s.cacheValue(ctx, "campaign", data, ttl, campaign)
}

func (s *Store) CachedRepositoryMemoryFile(ctx context.Context, campaign, commit, path string) ([]byte, error) {
	return s.cached(ctx, "file", campaign, commit, path)
}

func (s *Store) CacheRepositoryMemoryFile(ctx context.Context, campaign, commit, path string, data []byte, ttl time.Duration) error {
	return s.cacheValue(ctx, "file", data, ttl, campaign, commit, path)
}
