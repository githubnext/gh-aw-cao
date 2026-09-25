package redisx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

const redisWriteBatchSize = 100

var ErrSourceUnavailable = errors.New("redis source is unavailable")

type Store struct {
	Client    CommandClient
	namespace string
}

type CommandClient interface {
	Do(context.Context, ...string) (any, error)
	DoMany(context.Context, [][]string) ([]any, error)
}

func NewStore(client CommandClient, namespaces ...string) *Store {
	var namespace string
	switch len(namespaces) {
	case 0:
		defaultNamespace, err := DefaultNamespace(".")
		if err != nil {
			panic(err)
		}
		namespace = defaultNamespace
	case 1:
		namespace = namespaces[0]
	default:
		panic("NewStore accepts at most one Redis namespace")
	}
	normalized, err := NormalizeNamespace(namespace)
	if err != nil {
		panic(err)
	}
	return &Store{Client: client, namespace: normalized}
}

func (s *Store) Ping(ctx context.Context) error {
	value, err := s.Client.Do(ctx, "PING")
	if err != nil {
		return err
	}
	if fmt.Sprint(value) != "PONG" {
		return errors.New("unexpected Redis PING response")
	}
	return nil
}

func (s *Store) TryLock(ctx context.Context, name, token string, ttl time.Duration) (bool, error) {
	value, err := s.Client.Do(ctx, "SET", s.Key("lock:"+name), token, "NX", "PX", strconv.FormatInt(ttl.Milliseconds(), 10))
	if err != nil {
		return false, err
	}
	return value != nil && fmt.Sprint(value) == "OK", nil
}

func (s *Store) Unlock(ctx context.Context, name, token string) error {
	script := `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`
	_, err := s.Client.Do(ctx, "EVAL", script, "1", s.Key("lock:"+name), token)
	return err
}

func (s *Store) LockHeld(ctx context.Context, name string) (bool, error) {
	value, err := s.Client.Do(ctx, "GET", s.Key("lock:"+name))
	if err != nil {
		return false, err
	}
	return value != nil, nil
}

func (s *Store) RememberDelivery(ctx context.Context, delivery string, ttl time.Duration) (bool, error) {
	sum := sha256.Sum256([]byte(delivery))
	key := s.Key("github-delivery:" + hex.EncodeToString(sum[:]))
	value, err := s.Client.Do(ctx, "SET", key, "1", "NX", "PX", strconv.FormatInt(ttl.Milliseconds(), 10))
	if err != nil {
		return false, err
	}
	return value != nil && fmt.Sprint(value) == "OK", nil
}

func (s *Store) ForgetDelivery(ctx context.Context, delivery string) error {
	sum := sha256.Sum256([]byte(delivery))
	_, err := s.Client.Do(ctx, "DEL", s.Key("github-delivery:"+hex.EncodeToString(sum[:])))
	return err
}

func (s *Store) SetOperationalState(ctx context.Context, name string, value []byte) error {
	_, err := s.Client.Do(ctx, "SET", s.Key("state:"+name), string(value))
	return err
}

func (s *Store) OperationalState(ctx context.Context, name string) ([]byte, error) {
	value, err := s.Client.Do(ctx, "GET", s.Key("state:"+name))
	if err != nil || value == nil {
		return nil, err
	}
	return []byte(fmt.Sprint(value)), nil
}

func (s *Store) Key(suffix string) string {
	return s.namespace + ":" + suffix
}

func (s *Store) Active(ctx context.Context) (model.ActiveGeneration, error) {
	value, err := s.Client.Do(ctx, "HGETALL", s.activeKey())
	if err != nil {
		return model.ActiveGeneration{}, err
	}
	fields, err := Strings(value)
	if err != nil {
		return model.ActiveGeneration{}, err
	}
	if len(fields) == 0 {
		return model.ActiveGeneration{Counts: map[string]int{}}, nil
	}
	result := model.ActiveGeneration{Counts: map[string]int{}}
	for i := 0; i+1 < len(fields); i += 2 {
		switch fields[i] {
		case "generation":
			result.Generation = fields[i+1]
		case "revision":
			result.Revision, _ = strconv.ParseInt(fields[i+1], 10, 64)
		case "dataRevision":
			result.DataRevision = fields[i+1]
		case "evaluatedAt":
			result.EvaluatedAt, _ = time.Parse(time.RFC3339Nano, fields[i+1])
		case "counts":
			_ = json.Unmarshal([]byte(fields[i+1]), &result.Counts)
		case "activatedAt":
			result.Activated, _ = time.Parse(time.RFC3339Nano, fields[i+1])
		}
	}
	return result, nil
}

func (s *Store) Activate(ctx context.Context, generation, dataRevision string, evaluatedAt time.Time, counts map[string]int) (int64, error) {
	redisLog.Printf("activating generation sources=%d", len(counts))
	data, _ := json.Marshal(counts)
	activated := time.Now().UTC().Format(time.RFC3339Nano)
	script := `local revision = redis.call("INCR", KEYS[3]); redis.call("HSET", KEYS[1], "generation", ARGV[1], "revision", revision, "dataRevision", ARGV[2], "evaluatedAt", ARGV[3], "counts", ARGV[4], "activatedAt", ARGV[5]); redis.call("SET", KEYS[2], ARGV[1]); return revision`
	value, err := s.Client.Do(
		ctx, "EVAL", script, "3", s.activeKey(), s.activeGenerationKey(), s.revisionSequenceKey(),
		generation, dataRevision, evaluatedAt.UTC().Format(time.RFC3339Nano), string(data), activated,
	)
	if err != nil {
		return 0, fmt.Errorf("activate Redis generation: %w", err)
	}
	revision, ok := value.(int64)
	if !ok {
		return 0, errors.New("activate Redis generation returned an invalid revision")
	}
	return revision, nil
}

// PutSource stages one source's rows.
//
// Rows are stored as a single raw JSON document per key plus a set of the keys
// in the source. Nothing else is written: the previous implementation also
// wrote every scalar field as its own hash field purely so RediSearch could
// index it, which doubled the memory a generation occupied to serve a pushdown
// path that no canonical query was eligible for.
func (s *Store) PutSource(ctx context.Context, generation string, source model.Source) error {
	redisLog.Printf("staging source rows=%d", len(source.Rows))
	prefix := s.rowPrefix(generation, source.Source)
	setKey := s.sourceSetKey(generation, source.Source)
	commands := make([][]string, 0, redisWriteBatchSize)
	flush := func(rowNumber int) error {
		if len(commands) == 0 {
			return nil
		}
		if _, err := s.Client.DoMany(ctx, commands); err != nil {
			return fmt.Errorf("write %s rows through %d: %w", source.Source, rowNumber, err)
		}
		commands = commands[:0]
		return nil
	}
	script := `redis.call("HSET", KEYS[1], "raw", ARGV[1]); redis.call("SADD", KEYS[2], KEYS[1]); return "OK"`
	for rowNumber, row := range source.Rows {
		data, err := json.Marshal(row)
		if err != nil {
			return fmt.Errorf("encode %s row: %w", source.Source, err)
		}
		key := prefix + rowID(row, rowNumber)
		commands = append(commands, []string{"EVAL", script, "2", key, setKey, string(data)})
		if len(commands) == cap(commands) {
			if err := flush(rowNumber); err != nil {
				return err
			}
		}
	}
	if err := flush(len(source.Rows) - 1); err != nil {
		return err
	}
	metadata, _ := json.Marshal(source.Metadata)
	if _, err := s.Client.Do(ctx, "HSET", s.generationKey(generation),
		"source:"+source.Source+":metadata", string(metadata),
	); err != nil {
		return err
	}
	return nil
}

func (s *Store) PutDiagnostics(ctx context.Context, generation string, diagnostics model.Diagnostics) error {
	data, err := json.Marshal(diagnostics)
	if err != nil {
		return err
	}
	_, err = s.Client.Do(ctx, "HSET", s.generationKey(generation), "diagnostics", string(data))
	return err
}

func (s *Store) Diagnostics(ctx context.Context, generation string) (model.Diagnostics, error) {
	value, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "diagnostics")
	if err != nil {
		return model.Diagnostics{}, err
	}
	if value == nil {
		return model.Diagnostics{}, errors.New("diagnostics are unavailable")
	}
	var diagnostics model.Diagnostics
	if err := json.Unmarshal([]byte(fmt.Sprint(value)), &diagnostics); err != nil {
		return model.Diagnostics{}, err
	}
	return diagnostics, nil
}

// LoadSource reads a source's rows and lets the query engine evaluate the
// definition.
//
// There is deliberately no query pushdown. Pushdown required RediSearch, and
// therefore a Redis tier with modules, while none of the canonical projection
// queries were eligible for it: each one joins, unions, computes, or projects
// columns, and none bounds its result below the search result cap. Evaluating
// in the engine is the path those queries always took, so removing pushdown
// removed a second implementation rather than a capability.
func (s *Store) LoadSource(ctx context.Context, generation, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	metadata, err := s.sourceInfo(ctx, generation, name)
	if err != nil {
		return model.Source{}, model.Metrics{}, err
	}
	_ = definition
	metrics := model.Metrics{FallbackOperations: []string{"query"}, RedisCommands: 1}
	value, err := s.Client.Do(ctx, "SMEMBERS", s.sourceSetKey(generation, name))
	metrics.RedisCommands++
	if err != nil {
		return model.Source{}, metrics, err
	}
	keys, err := Strings(value)
	if err != nil {
		return model.Source{}, metrics, err
	}
	sort.Strings(keys)
	if len(keys) > query.MaxInputRows {
		return model.Source{}, metrics, fmt.Errorf("source %q exceeds max input rows", name)
	}
	rows := make([]model.Row, 0, len(keys))
	const batchSize = 1000
	script := `local out = {}; for i,key in ipairs(KEYS) do out[i] = redis.call("HGET", key, "raw"); end; return out`
	for offset := 0; offset < len(keys); offset += batchSize {
		end := min(len(keys), offset+batchSize)
		command := make([]string, 0, 3+end-offset)
		command = append(command, "EVAL", script, strconv.Itoa(end-offset))
		command = append(command, keys[offset:end]...)
		value, err := s.Client.Do(ctx, command...)
		metrics.RedisCommands++
		if err != nil {
			return model.Source{}, metrics, err
		}
		rawRows, err := Strings(value)
		if err != nil {
			return model.Source{}, metrics, err
		}
		for _, raw := range rawRows {
			var row model.Row
			if err := json.Unmarshal([]byte(raw), &row); err != nil {
				return model.Source{}, metrics, err
			}
			rows = append(rows, row)
		}
	}
	metrics.RedisRows = len(rows)
	redisLog.Printf("loaded source rows=%d mode=fallback", len(rows))
	return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
}

func (s *Store) sourceInfo(ctx context.Context, generation, name string) (model.Metadata, error) {
	value, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), "source:"+name+":metadata")
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	metadata := model.Metadata{}
	if raw := fmt.Sprint(value); raw != "" {
		_ = json.Unmarshal([]byte(raw), &metadata)
	}
	return metadata, nil
}

func rowID(row model.Row, fallback int) string {
	for _, field := range []string{"id", "event", "run", "repository-coordinate"} {
		if value := strings.TrimSpace(fmt.Sprint(row[field])); value != "" && value != "<nil>" {
			sum := sha256.Sum256([]byte(value))
			return hex.EncodeToString(sum[:16])
		}
	}
	data, _ := json.Marshal(row)
	data = append(data, strconv.Itoa(fallback)...)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

func safeName(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}

func (s *Store) activeKey() string { return s.namespace + ":active" }
func (s *Store) activeGenerationKey() string {
	return s.namespace + ":active-generation"
}
func (s *Store) revisionSequenceKey() string { return s.namespace + ":revision-sequence" }
func (s *Store) generationKey(generation string) string {
	return s.namespace + ":g:" + generation
}
func (s *Store) sourceSetKey(generation, source string) string {
	return s.generationKey(generation) + ":source:" + safeName(source) + ":rows"
}
func (s *Store) rowPrefix(generation, source string) string {
	return s.generationKey(generation) + ":source:" + safeName(source) + ":row:"
}
