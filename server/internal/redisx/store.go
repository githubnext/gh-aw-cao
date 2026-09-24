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
	Client    *Client
	namespace string
}

func NewStore(client *Client, namespaces ...string) *Store {
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

func (s *Store) CheckRediSearch(ctx context.Context) error {
	if _, err := s.Client.Do(ctx, "FT._LIST"); err != nil {
		return fmt.Errorf("redis RediSearch module is unavailable: %w", err)
	}
	return nil
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

func (s *Store) PutSource(ctx context.Context, generation string, source model.Source) (map[string]string, error) {
	aliases, types := sourceSchema(source.Rows)
	prefix := s.rowPrefix(generation, source.Source)
	index := s.indexName(generation, source.Source)
	_, _ = s.Client.Do(ctx, "FT.DROPINDEX", index)
	indexCommand := []string{"FT.CREATE", index, "ON", "HASH", "PREFIX", "1", prefix, "SCHEMA", "raw", "TEXT", "NOSTEM"}
	fields := make([]string, 0, len(aliases))
	for field := range aliases {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	for _, field := range fields {
		indexCommand = append(indexCommand, aliases[field], types[field])
		if types[field] == "TEXT" {
			indexCommand = append(indexCommand, "NOSTEM")
		}
		indexCommand = append(indexCommand, "SORTABLE")
	}
	if _, err := s.Client.Do(ctx, indexCommand...); err != nil {
		return nil, fmt.Errorf("create RediSearch index for %s: %w", source.Source, err)
	}
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
	for rowNumber, row := range source.Rows {
		data, err := json.Marshal(row)
		if err != nil {
			return nil, fmt.Errorf("encode %s row: %w", source.Source, err)
		}
		id := rowID(row, rowNumber)
		key := prefix + id
		command := []string{"HSET", key, "raw", string(data)}
		for _, field := range fields {
			value, ok := scalarIndexValue(row[field])
			if types[field] == "NUMERIC" {
				if number, numeric := numericIndexValue(row[field]); numeric {
					value, ok = strconv.FormatFloat(number, 'g', -1, 64), true
				} else {
					ok = false
				}
			}
			if ok {
				command = append(command, aliases[field], value)
			}
		}
		script := `redis.call("HSET", KEYS[1], unpack(ARGV)); redis.call("SADD", KEYS[2], KEYS[1]); return "OK"`
		arguments := []string{"EVAL", script, "2", key, setKey}
		arguments = append(arguments, command[2:]...)
		commands = append(commands, arguments)
		if len(commands) == cap(commands) {
			if err := flush(rowNumber); err != nil {
				return nil, err
			}
		}
	}
	if err := flush(len(source.Rows) - 1); err != nil {
		return nil, err
	}
	metadata, _ := json.Marshal(source.Metadata)
	schema, _ := json.Marshal(aliases)
	schemaTypes, _ := json.Marshal(types)
	if _, err := s.Client.Do(ctx, "HSET", s.generationKey(generation),
		"source:"+source.Source+":metadata", string(metadata),
		"source:"+source.Source+":aliases", string(schema),
		"source:"+source.Source+":types", string(schemaTypes),
	); err != nil {
		return nil, err
	}
	return aliases, nil
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

func (s *Store) LoadSource(ctx context.Context, generation, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	metadata, aliases, types, err := s.sourceInfo(ctx, generation, name)
	if err != nil {
		return model.Source{}, model.Metrics{}, err
	}
	plan := PlanQuery(s.indexName(generation, name), name, definition, aliases, types)
	metrics := model.Metrics{PushedDown: plan.PushedDown, FallbackOperations: plan.Fallback, RedisCommands: 1}
	if len(plan.PushedDown) > 0 {
		value, searchErr := s.Client.Do(ctx, plan.Command...)
		metrics.RedisCommands++
		if searchErr == nil {
			rows, parseErr := parseSearchRows(value, plan.Aggregate)
			if parseErr == nil {
				if plan.Aggregate {
					inverse := map[string]string{}
					for field, alias := range aliases {
						inverse[alias] = field
					}
					for _, row := range rows {
						for field, value := range row {
							if original := inverse[field]; original != "" {
								delete(row, field)
								row[original] = value
							}
						}
					}
				}
				metrics.RedisRows = len(rows)
				return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
			}
		}
		metrics.FallbackOperations = append(metrics.FallbackOperations, "redis-search-error")
		metrics.PushedDown = nil
	}
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
	return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
}

func (s *Store) sourceInfo(ctx context.Context, generation, name string) (model.Metadata, map[string]string, map[string]string, error) {
	value, err := s.Client.Do(ctx, "HMGET", s.generationKey(generation), "source:"+name+":metadata", "source:"+name+":aliases", "source:"+name+":types")
	if err != nil {
		return nil, nil, nil, err
	}
	fields, err := Strings(value)
	if err != nil || len(fields) != 3 {
		return nil, nil, nil, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	metadata := model.Metadata{}
	aliases := map[string]string{}
	types := map[string]string{}
	if fields[0] != "" {
		_ = json.Unmarshal([]byte(fields[0]), &metadata)
	}
	if fields[1] != "" {
		_ = json.Unmarshal([]byte(fields[1]), &aliases)
	}
	if fields[2] != "" {
		_ = json.Unmarshal([]byte(fields[2]), &types)
	}
	if fields[0] == "" && fields[1] == "" {
		return nil, nil, nil, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	return metadata, aliases, types, nil
}

func sourceSchema(rows []model.Row) (map[string]string, map[string]string) {
	aliases, types := map[string]string{}, map[string]string{}
	stringValues := map[string]map[string]bool{}
	for _, row := range rows {
		for field, value := range row {
			if _, ok := scalarIndexValue(value); !ok {
				continue
			}
			if aliases[field] == "" {
				sum := sha256.Sum256([]byte(field))
				aliases[field] = "f_" + hex.EncodeToString(sum[:6])
			}
			if _, ok := numericIndexValue(value); ok {
				if types[field] == "" {
					types[field] = "NUMERIC"
				}
			} else if _, ok := value.(bool); ok {
				types[field] = "TAG"
			} else {
				if stringValues[field] == nil {
					stringValues[field] = map[string]bool{}
				}
				stringValues[field][fmt.Sprint(value)] = true
				if types[field] != "NUMERIC" {
					types[field] = "TAG"
				}
			}
		}
	}
	for field, values := range stringValues {
		lower := strings.ToLower(field)
		textual := strings.Contains(lower, "title") || strings.Contains(lower, "message") ||
			strings.Contains(lower, "detail") || strings.Contains(lower, "description") ||
			strings.Contains(lower, "readme") || strings.Contains(lower, "summary")
		if textual || len(values) > max(64, len(rows)/4) {
			types[field] = "TEXT"
		}
	}
	return aliases, types
}

func scalarIndexValue(value any) (string, bool) {
	switch value := value.(type) {
	case string:
		return value, true
	case float64:
		return strconv.FormatFloat(value, 'g', -1, 64), true
	case int:
		return strconv.Itoa(value), true
	case bool:
		return strconv.FormatBool(value), true
	case nil:
		return "", false
	default:
		return "", false
	}
}

func numericIndexValue(value any) (float64, bool) {
	switch value := value.(type) {
	case float64:
		return value, true
	case int:
		return float64(value), true
	default:
		if text, ok := value.(string); ok {
			if instant, err := time.Parse(time.RFC3339Nano, text); err == nil {
				return float64(instant.UnixMilli()), true
			}
		}
		return 0, false
	}
}

func parseSearchRows(value any, aggregate bool) ([]model.Row, error) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil, errors.New("invalid RediSearch response")
	}
	rows := []model.Row{}
	if aggregate {
		for i := 1; i < len(items); i++ {
			fields, ok := items[i].([]any)
			if !ok {
				continue
			}
			row := model.Row{}
			for j := 0; j+1 < len(fields); j += 2 {
				row[fmt.Sprint(fields[j])] = parseScalar(fmt.Sprint(fields[j+1]))
			}
			rows = append(rows, row)
		}
		return rows, nil
	}
	for i := 1; i+1 < len(items); i += 2 {
		fields, ok := items[i+1].([]any)
		if !ok {
			continue
		}
		for j := 0; j+1 < len(fields); j += 2 {
			if fmt.Sprint(fields[j]) != "raw" {
				continue
			}
			var row model.Row
			if err := json.Unmarshal([]byte(fmt.Sprint(fields[j+1])), &row); err != nil {
				return nil, err
			}
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func parseScalar(value string) any {
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	return value
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
func (s *Store) indexName(generation, source string) string {
	return s.namespace + ":idx:" + safeName(generation+"|"+source)
}
