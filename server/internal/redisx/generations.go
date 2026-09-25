package redisx

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// generationRetentionGrace is how long a superseded generation is kept after a
// newer one is activated. Activation only flips a pointer, so a reader that
// resolved the previous generation may still be reading its rows.
// Dropping it immediately would fail those reads.
const generationRetentionGrace = 10 * time.Minute

// DefaultGenerationRetention is how many generations are kept regardless of
// age, so a rollback target always exists.
const DefaultGenerationRetention = 3

func (s *Store) generationsKey() string { return s.namespace + ":generations" }

// TrackGeneration records a generation so it can be reclaimed later.
//
// Generations are timestamp-named and every projection writes a complete new
// one, so without a registry the only way to find superseded generations would
// be a keyspace scan.
func (s *Store) TrackGeneration(ctx context.Context, generation string) error {
	score := strconv.FormatInt(time.Now().UTC().UnixMilli(), 10)
	_, err := s.Client.Do(ctx, "ZADD", s.generationsKey(), score, generation)
	if err != nil {
		return fmt.Errorf("track generation: %w", err)
	}
	return nil
}

// PruneGenerations reclaims superseded generations.
//
// Each projection writes a full copy of the canonical dataset. Redis is
// configured NoEviction, so without reclamation a
// frequently projecting deployment exhausts memory and every subsequent write
// fails. Reclamation is therefore part of activation, not an operator task.
//
// The active generation is never dropped, the newest retain generations are
// kept regardless of age, and a generation superseded less than the retention
// grace ago is left alone so in-flight reads complete.
func (s *Store) PruneGenerations(ctx context.Context, retain int) (int, error) {
	if retain < 1 {
		retain = DefaultGenerationRetention
	}
	active, err := s.Client.Do(ctx, "GET", s.activeGenerationKey())
	if err != nil {
		return 0, fmt.Errorf("read active generation: %w", err)
	}
	activeGeneration := ""
	if active != nil {
		activeGeneration = fmt.Sprint(active)
	}
	value, err := s.Client.Do(ctx, "ZRANGE", s.generationsKey(), "0", "-1", "WITHSCORES")
	if err != nil {
		return 0, fmt.Errorf("list generations: %w", err)
	}
	entries, err := Strings(value)
	if err != nil {
		return 0, fmt.Errorf("decode generations: %w", err)
	}
	type tracked struct {
		name     string
		recorded time.Time
	}
	var generations []tracked
	for index := 0; index+1 < len(entries); index += 2 {
		name := entries[index]
		if name == "" {
			continue
		}
		milliseconds, _ := strconv.ParseInt(entries[index+1], 10, 64)
		generations = append(generations, tracked{
			name: name, recorded: time.UnixMilli(milliseconds).UTC(),
		})
	}
	// ZRANGE returns oldest first, so everything except the newest retain
	// entries is a reclamation candidate.
	cutoff := len(generations) - retain
	dropped := 0
	for index := 0; index < cutoff; index++ {
		candidate := generations[index]
		if candidate.name == activeGeneration {
			continue
		}
		if time.Since(candidate.recorded) < generationRetentionGrace {
			continue
		}
		if err := s.DropGeneration(ctx, candidate.name); err != nil {
			return dropped, err
		}
		if _, err := s.Client.Do(ctx, "ZREM", s.generationsKey(), candidate.name); err != nil {
			return dropped, fmt.Errorf("forget generation: %w", err)
		}
		dropped++
	}
	if dropped > 0 {
		redisLog.Printf("reclaimed generations dropped=%d retained=%d", dropped, retain)
	}
	return dropped, nil
}

// DropGeneration deletes one generation's rows, row sets, search indexes, and
// metadata. It is safe to call for a generation that is already gone.
func (s *Store) DropGeneration(ctx context.Context, generation string) error {
	if strings.TrimSpace(generation) == "" {
		return nil
	}
	sources, err := s.generationSources(ctx, generation)
	if err != nil {
		return err
	}
	for _, source := range sources {
		setKey := s.sourceSetKey(generation, source)
		members, err := s.Client.Do(ctx, "SMEMBERS", setKey)
		if err != nil {
			return fmt.Errorf("read generation rows: %w", err)
		}
		rows, _ := Strings(members)
		batch := make([][]string, 0, redisWriteBatchSize)
		for _, key := range rows {
			if key == "" {
				continue
			}
			batch = append(batch, []string{"UNLINK", key})
			if len(batch) == cap(batch) {
				if _, err := s.Client.DoMany(ctx, batch); err != nil {
					return fmt.Errorf("reclaim generation rows: %w", err)
				}
				batch = batch[:0]
			}
		}
		if len(batch) > 0 {
			if _, err := s.Client.DoMany(ctx, batch); err != nil {
				return fmt.Errorf("reclaim generation rows: %w", err)
			}
		}
		if _, err := s.Client.Do(ctx, "UNLINK", setKey); err != nil {
			return fmt.Errorf("reclaim generation row set: %w", err)
		}
	}
	if _, err := s.Client.Do(ctx, "UNLINK", s.generationKey(generation)); err != nil {
		return fmt.Errorf("reclaim generation metadata: %w", err)
	}
	return nil
}

// generationSources reads the source names a generation staged, which are
// recorded as source:<name>:metadata fields on the generation hash.
func (s *Store) generationSources(ctx context.Context, generation string) ([]string, error) {
	value, err := s.Client.Do(ctx, "HKEYS", s.generationKey(generation))
	if err != nil {
		return nil, fmt.Errorf("read generation fields: %w", err)
	}
	fields, err := Strings(value)
	if err != nil {
		return nil, fmt.Errorf("decode generation fields: %w", err)
	}
	var sources []string
	for _, name := range fields {
		if !strings.HasPrefix(name, "source:") || !strings.HasSuffix(name, ":metadata") {
			continue
		}
		source := strings.TrimSuffix(strings.TrimPrefix(name, "source:"), ":metadata")
		if source != "" {
			sources = append(sources, source)
		}
	}
	return sources, nil
}
