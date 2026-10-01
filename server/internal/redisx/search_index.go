package redisx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Search documents are disposable secondary indexes of the single canonical
// dataset, never an authority or a retained copy of an older publication.
// A revision marker enables them only after rebuilding and verifying every
// source; reads fall back to canonical hashes whenever the marker is absent.
func (s *Store) RequireIndexedModules(ctx context.Context) error {
	if s.processIsolated {
		return nil
	}
	required := []string{"JSON.SET", "FT.CREATE", "FT.SEARCH", "FT.AGGREGATE"}
	result, err := s.Client.Do(ctx, append([]string{"COMMAND", "INFO"}, required...)...)
	if err != nil {
		return fmt.Errorf("verify Redis JSON/Search support: %w", err)
	}
	commands, ok := result.([]any)
	if !ok || len(commands) != len(required) {
		return errors.New("Redis JSON/Search command information is unavailable")
	}
	for index, command := range commands {
		if command == nil {
			return fmt.Errorf("required Redis JSON/Search command %s is unavailable", required[index])
		}
	}
	return nil
}

func (s *Store) SearchIndexesReady(ctx context.Context, revision int64) (bool, error) {
	if s.processIsolated {
		return true, nil
	}
	value, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "indexedRevision")
	return err == nil && toInt64(value) == revision, err
}

func (s *Store) RebuildSearchIndexes(ctx context.Context, revision int64, counts map[string]int) error {
	if s.processIsolated {
		return nil
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	token := hex.EncodeToString(nonce[:])
	held, err := s.TryLock(ctx, "search-index", token, time.Hour)
	if err != nil {
		return err
	}
	if !held {
		return errors.New("search index rebuild is already running")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = s.Unlock(cleanup, "search-index", token)
	}()
	invalidate := `if redis.call("HGET", KEYS[1], "revision") ~= ARGV[1] then
  return redis.error_reply("dataset changed during search indexing")
end
redis.call("HDEL", KEYS[2], "indexedRevision")
redis.call("HINCRBY", KEYS[2], "indexedEpoch", 1)
return 1`
	if _, err := s.Client.Do(ctx, "EVAL", invalidate, "2", s.activeKey(), s.datasetKey(),
		strconv.FormatInt(revision, 10)); err != nil {
		return err
	}
	previous, err := s.Client.Do(ctx, "SMEMBERS", s.Key("search:sources"))
	if err != nil {
		return err
	}
	names, err := Strings(previous)
	if err != nil {
		return err
	}
	for name := range counts {
		if !containsField(names, name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if current, err := s.DatasetRevision(ctx); err != nil || current != revision {
			return errors.New("dataset changed during search indexing")
		}
		if err := s.dropSourceIndex(ctx, name); err != nil {
			return err
		}
		if _, ok := counts[name]; !ok || name == "issues" {
			if _, err := s.Client.Do(ctx, "SREM", s.Key("search:sources"), name); err != nil {
				return err
			}
			continue
		}
		raw, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "source:"+name+":index-schema")
		if err != nil {
			return err
		}
		var schema []indexField
		if raw != nil {
			if err := json.Unmarshal([]byte(fmt.Sprint(raw)), &schema); err != nil {
				return err
			}
		}
		if len(schema) == 0 {
			if _, err := s.Client.Do(ctx, "SREM", s.Key("search:sources"), name); err != nil {
				return err
			}
			continue
		}
		if _, err := s.Client.Do(ctx, "SADD", s.Key("search:sources"), name); err != nil {
			return err
		}
		command := append([]string{"FT.CREATE", s.sourceIndexKey(name),
			"ON", "JSON", "PREFIX", "1", s.indexRowPrefix(name), "SCHEMA"}, redisIndexSchema(schema)...)
		if _, err := s.Client.Do(ctx, command...); err != nil {
			return fmt.Errorf("create search index: %w", err)
		}
		cursor := "0"
		for {
			if current, err := s.DatasetRevision(ctx); err != nil || current != revision {
				return errors.New("dataset changed during search indexing")
			}
			page, err := s.boundedSourceScan(ctx, s.sourceHashKey(name), cursor)
			if err != nil {
				return err
			}
			reply, ok := page.([]any)
			if !ok || len(reply) != 2 {
				return errors.New("invalid canonical source scan")
			}
			cursor = fmt.Sprint(reply[0])
			fields, err := Strings(reply[1])
			if err != nil || len(fields)%2 != 0 {
				return errors.New("invalid canonical source fields")
			}
			commands := make([][]string, 0, len(fields)/2)
			for i := 0; i < len(fields); i += 2 {
				if fields[i] == "_staged" {
					continue
				}
				key := s.indexRowPrefix(name) + fields[i]
				script := `redis.call("SADD", KEYS[2], KEYS[1]); redis.call("JSON.SET", KEYS[1], "$", ARGV[1]); return 1`
				commands = append(commands, []string{"EVAL", script, "2", key, s.indexRowsKey(name), fields[i+1]})
			}
			if len(commands) > 0 {
				if _, err := s.Client.DoMany(ctx, commands); err != nil {
					return err
				}
			}
			if cursor == "0" {
				break
			}
		}
		result, err := s.Client.Do(ctx, "FT.SEARCH", s.sourceIndexKey(name), "*", "NOCONTENT", "LIMIT", "0", "0")
		if err != nil {
			return err
		}
		reply, ok := result.([]any)
		if !ok || len(reply) == 0 || toInt64(reply[0]) != int64(counts[name]) {
			return errors.New("search index is incomplete")
		}
	}
	ready := `if redis.call("HGET", KEYS[1], "revision") ~= ARGV[1] then
  return redis.error_reply("dataset changed during search indexing")
end
redis.call("HSET", KEYS[2], "indexedRevision", ARGV[1])
return 1`
	_, err = s.Client.Do(ctx, "EVAL", ready, "2", s.activeKey(), s.datasetKey(), strconv.FormatInt(revision, 10))
	return err
}

func (s *Store) dropSourceIndex(ctx context.Context, name string) error {
	_, err := s.Client.Do(ctx, "FT.DROPINDEX", s.sourceIndexKey(name))
	var responseErr redisResponseError
	if err != nil && (!errors.As(err, &responseErr) ||
		!strings.Contains(responseErr.message, "no such index") &&
			!strings.Contains(responseErr.message, "Unknown Index name") &&
			!strings.Contains(responseErr.message, "Index not found")) {
		return err
	}
	cursor := "0"
	for {
		reply, err := s.Client.Do(ctx, "SSCAN", s.indexRowsKey(name), cursor, "COUNT", "100")
		if err != nil {
			return err
		}
		page, ok := reply.([]any)
		if !ok || len(page) != 2 {
			return errors.New("invalid indexed row scan")
		}
		cursor = fmt.Sprint(page[0])
		keys, err := Strings(page[1])
		if err != nil {
			return err
		}
		for offset := 0; offset < len(keys); offset += redisWriteBatchSize {
			end := min(len(keys), offset+redisWriteBatchSize)
			if _, err := s.Client.Do(ctx, append([]string{"UNLINK"}, keys[offset:end]...)...); err != nil {
				return err
			}
		}
		if cursor == "0" {
			break
		}
	}
	_, err = s.Client.Do(ctx, "UNLINK", s.indexRowsKey(name))
	return err
}
