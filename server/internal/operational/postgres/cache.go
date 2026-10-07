package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func cacheKey(kind string, parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(part))
		_, _ = h.Write([]byte{0})
	}
	return kind + ":" + hex.EncodeToString(h.Sum(nil))
}

func queryKey(digest string) (string, error) {
	value, err := hex.DecodeString(digest)
	if err != nil || len(value) != sha256.Size {
		return "", invalid("query identity must be a SHA-256 digest")
	}
	return "query:" + strings.ToLower(digest), nil
}

func (t *transaction) cacheStats(queryOnly bool) (operational.QueryCacheStats, error) {
	var result operational.QueryCacheStats
	err := t.tx.QueryRowContext(t.ctx, `SELECT count(*),coalesce(sum(octet_length(key)+octet_length(value)+128),0) FROM cao_operational_cache WHERE namespace=$1 AND (NOT $2 OR query)`, t.namespace, queryOnly).Scan(&result.Entries, &result.MemoryBytes)
	return result, err
}

func (t *transaction) expireCache() (int64, error) {
	var expired int64
	if err := t.tx.QueryRowContext(t.ctx, `SELECT count(*) FROM cao_operational_cache WHERE namespace=$1 AND query AND expires_at<=$2`, t.namespace, t.now).Scan(&expired); err != nil {
		return 0, err
	}
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM cao_operational_cache WHERE namespace=$1 AND expires_at<=$2`, t.namespace, t.now)
	return expired, err
}

func (t *transaction) trimCache(queryOnly bool, bytes, entries, addBytes, addEntries int64) (int64, error) {
	var queryEvicted int64
	for {
		stats, err := t.cacheStats(queryOnly)
		if err != nil {
			return 0, err
		}
		if stats.MemoryBytes+addBytes <= bytes && stats.Entries+addEntries <= entries {
			return queryEvicted, nil
		}
		var query bool
		err = t.tx.QueryRowContext(t.ctx, `DELETE FROM cao_operational_cache WHERE namespace=$1 AND key=(SELECT key FROM cao_operational_cache WHERE namespace=$1 AND (NOT $2 OR query) ORDER BY position LIMIT 1) RETURNING query`, t.namespace, queryOnly).Scan(&query)
		if errors.Is(err, sql.ErrNoRows) {
			return queryEvicted, operational.ErrCapacity
		}
		if err != nil {
			return 0, err
		}
		if query {
			queryEvicted++
		}
	}
}

func (t *transaction) cached(key string) ([]byte, error) {
	var data []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT value FROM cao_operational_cache WHERE namespace=$1 AND key=$2 AND expires_at>$3`, t.namespace, key, t.now).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return data, err
}

func (s *Store) CachedQueryResult(ctx context.Context, digest string, maxResultBytes, maxBytes int64) ([]byte, operational.QueryCacheStats, error) {
	return s.queryCache(ctx, digest, nil, maxResultBytes, maxBytes, false)
}

func (s *Store) CacheQueryResult(ctx context.Context, digest string, data []byte, maxResultBytes, maxBytes int64) (bool, operational.QueryCacheStats, error) {
	result, stats, err := s.queryCache(ctx, digest, data, maxResultBytes, maxBytes, true)
	return result != nil && err == nil, stats, err
}

func (s *Store) queryCache(ctx context.Context, digest string, data []byte, maxResultBytes, maxBytes int64, write bool) ([]byte, operational.QueryCacheStats, error) {
	key, err := queryKey(digest)
	if err != nil {
		return nil, operational.QueryCacheStats{}, err
	}
	if maxResultBytes <= 0 || maxBytes <= 0 {
		return nil, operational.QueryCacheStats{}, invalid("query limits must be positive")
	}
	var result []byte
	var stats operational.QueryCacheStats
	err = s.transact(ctx, func(t *transaction) error {
		expired, err := t.expireCache()
		if err != nil {
			return err
		}
		size := int64(len(key)+len(data)) + 128
		if write && (int64(len(data)) > maxResultBytes ||
			int64(len(data)) > s.config.MaxCacheValueBytes || size > min(maxBytes, s.config.MaxCacheBytes)) {
			stats, err = t.cacheStats(true)
			stats.Expired = expired
			return err
		}
		evicted, err := t.trimCache(true, maxBytes, operational.QueryCacheMaxEntries, 0, 0)
		if err != nil {
			return err
		}
		result, err = t.cached(key)
		if err != nil {
			return err
		}
		if int64(len(result)) > maxResultBytes {
			if _, err := t.tx.ExecContext(ctx, `DELETE FROM cao_operational_cache WHERE namespace=$1 AND key=$2`, s.namespace, key); err != nil {
				return err
			}
			result = nil
			evicted++
		}
		if write && result == nil && int64(len(data)) <= maxResultBytes &&
			int64(len(data)) <= s.config.MaxCacheValueBytes && size <= min(maxBytes, s.config.MaxCacheBytes) {
			n, err := t.trimCache(true, maxBytes, operational.QueryCacheMaxEntries, size, 1)
			if err != nil {
				return err
			}
			evicted += n
			n, err = t.trimCache(false, s.config.MaxCacheBytes, s.config.MaxCacheEntries, size, 1)
			if err != nil {
				return err
			}
			evicted += n
			if err := t.saveCache(key, data, true, operational.QueryCacheTTL); err != nil {
				return err
			}
			result = make([]byte, len(data))
			copy(result, data)
		}
		stats, err = t.cacheStats(true)
		stats.Expired, stats.Evicted = expired, evicted
		return err
	})
	if err != nil {
		return nil, stats, err
	}
	return result, stats, nil
}

func (t *transaction) saveCache(key string, data []byte, query bool, ttl time.Duration) error {
	if data == nil {
		data = []byte{}
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO cao_operational_cache(namespace,key,query,value,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(namespace,key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at,position=DEFAULT`, t.namespace, key, query, data, t.now.Add(ttl))
	return err
}

func (s *Store) cached(ctx context.Context, kind string, parts ...string) ([]byte, error) {
	if err := names(parts...); err != nil {
		return nil, err
	}
	var value []byte
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		value, err = t.cached(cacheKey(kind, parts...))
		return err
	})
	return value, err
}

func (s *Store) cacheValue(ctx context.Context, kind string, data []byte, ttl time.Duration, parts ...string) error {
	if err := names(parts...); err != nil {
		return err
	}
	if err := ttlValid(ttl); err != nil {
		return err
	}
	key := cacheKey(kind, parts...)
	size := int64(len(key)+len(data)) + 128
	if int64(len(data)) > s.config.MaxCacheValueBytes || size > s.config.MaxCacheBytes {
		return operational.ErrCapacity
	}
	return s.transact(ctx, func(t *transaction) error {
		if _, err := t.expireCache(); err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `DELETE FROM cao_operational_cache WHERE namespace=$1 AND key=$2`, s.namespace, key); err != nil {
			return err
		}
		if _, err := t.trimCache(false, s.config.MaxCacheBytes, s.config.MaxCacheEntries, size, 1); err != nil {
			return err
		}
		return t.saveCache(key, data, false, ttl)
	})
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
