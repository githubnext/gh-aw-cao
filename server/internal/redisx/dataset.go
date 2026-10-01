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

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// A projection is assembled under expiring, unpublished keys. Only one
// logical dataset exists: publication replaces its fixed source keys and
// metadata in one Redis script; no previous copies or registry are retained.
const stagingTTL = time.Hour

func (s *Store) datasetKey() string { return s.Key("dataset") }

func (s *Store) sourceHashKey(source string) string {
	return s.Key("dataset:source:" + safeName(source))
}

func (s *Store) sourceIndexKey(source string) string {
	return s.Key("search:" + safeName(source) + ":index")
}

func (s *Store) indexRowPrefix(source string) string {
	return s.Key("search:" + safeName(source) + ":row:")
}

func (s *Store) indexRowsKey(source string) string {
	return s.Key("search:" + safeName(source) + ":rows")
}

func (s *Store) stagingKey(token string) string { return s.Key("staging:" + token) }

func (s *Store) stagingSourceKey(token, source string) string {
	return s.stagingKey(token) + ":source:" + safeName(source)
}

func (s *Store) stageField(ctx context.Context, token, field, value string) error {
	script := `if redis.call("EXISTS", KEYS[1]) == 0 then
  return redis.error_reply("staging dataset expired")
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
return 1`
	_, err := s.Client.Do(ctx, "EVAL", script, "1", s.stagingKey(token),
		field, value, strconv.FormatInt(int64(stagingTTL.Seconds()), 10))
	return err
}

func (s *Store) StageSource(ctx context.Context, token string, source model.Source) error {
	metadata, err := json.Marshal(source.Metadata)
	if err != nil {
		return err
	}
	if !s.processIsolated && source.Source != "issues" {
		schema, err := indexSchemaForSource(source, s.indexDefinitions)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(schema)
		if err != nil {
			return err
		}
		if err := s.stageField(ctx, token, "source:"+source.Source+":index-schema", string(encoded)); err != nil {
			return err
		}
		var tagged []string
		for _, field := range schema {
			if field.Kind == indexFieldTag {
				tagged = append(tagged, field.Name)
			}
		}
		encodedTags, _ := json.Marshal(tagged)
		if err := s.stageField(ctx, token, "source:"+source.Source+":indexed-fields", string(encodedTags)); err != nil {
			return err
		}
	}
	// Recording the source before writing rows makes interrupted stages
	// reclaimable even if a later row write fails.
	raw, err := s.Client.Do(ctx, "HGET", s.stagingKey(token), "sources")
	if err != nil || raw == nil {
		if err != nil {
			return err
		}
		return errors.New("staging dataset expired")
	}
	var names []string
	if err := json.Unmarshal([]byte(fmt.Sprint(raw)), &names); err != nil {
		return err
	}
	names = append(names, source.Source)
	namesJSON, _ := json.Marshal(names)
	key := s.stagingSourceKey(token, source.Source)
	ttl := strconv.FormatInt(int64(stagingTTL.Seconds()), 10)
	initialize := `if redis.call("EXISTS", KEYS[1]) == 0 then
  return redis.error_reply("staging dataset expired")
end
redis.call("HSET", KEYS[1], "sources", ARGV[1], ARGV[2], ARGV[3])
redis.call("HSET", KEYS[2], "_staged", "1")
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[4]))
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[4]))
return 1`
	if _, err := s.Client.Do(ctx, "EVAL", initialize, "2", s.stagingKey(token), key,
		string(namesJSON), "source:"+source.Source+":metadata", string(metadata), ttl); err != nil {
		return err
	}
	writeRow := `if redis.call("EXISTS", KEYS[1]) == 0 or redis.call("EXISTS", KEYS[2]) == 0 then
  return redis.error_reply("staging dataset expired")
end
redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[3]))
return 1`
	commands := make([][]string, 0, redisWriteBatchSize)
	for index, row := range source.Rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			return err
		}
		commands = append(commands, []string{"EVAL", writeRow, "2", s.stagingKey(token), key,
			rowID(row, index), string(encoded), ttl})
		if len(commands) == cap(commands) {
			if _, err := s.Client.DoMany(ctx, commands); err != nil {
				return err
			}
			commands = commands[:0]
		}
	}
	if len(commands) > 0 {
		if _, err := s.Client.DoMany(ctx, commands); err != nil {
			return err
		}
	}
	return nil
}

// BeginDataset reserves expiring staging storage and records the currently
// published revision. A concurrent publisher invalidates the staged write.
func (s *Store) BeginDataset(ctx context.Context) (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(nonce[:])
	script := `local revision = redis.call("HGET", KEYS[1], "revision") or "0"
redis.call("HSET", KEYS[2], "baseRevision", revision, "sources", "[]")
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[1]))
return revision`
	_, err := s.Client.Do(ctx, "EVAL", script, "2", s.activeKey(), s.stagingKey(token),
		strconv.FormatInt(int64(stagingTTL.Seconds()), 10))
	if err != nil {
		return "", fmt.Errorf("begin dataset: %w", err)
	}
	return token, nil
}

// DiscardDataset removes a failed projection; TTLs also reclaim every staging
// key after an interrupted process or failed cleanup.
func (s *Store) DiscardDataset(ctx context.Context, token string) error {
	value, err := s.Client.Do(ctx, "HGET", s.stagingKey(token), "sources")
	if err != nil {
		return err
	}
	var names []string
	if value != nil {
		if err := json.Unmarshal([]byte(fmt.Sprint(value)), &names); err != nil {
			return err
		}
	}
	keys := []string{s.stagingKey(token)}
	for _, name := range names {
		keys = append(keys, s.stagingSourceKey(token, name))
	}
	_, err = s.Client.Do(ctx, append([]string{"UNLINK"}, keys...)...)
	return err
}

// PublishDataset swaps all fixed source keys and metadata atomically. The
// preflight runs before any mutations so expiry or an interrupted stage cannot
// damage the published dataset. Readers fence multi-command reads by revision.
func (s *Store) PublishDataset(ctx context.Context, token, dataRevision string, evaluatedAt time.Time, counts map[string]int) (int64, error) {
	var sources []string
	for name := range counts {
		sources = append(sources, name)
	}
	sort.Strings(sources)
	previous, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "sources")
	if err != nil {
		return 0, err
	}
	keys := []string{s.stagingKey(token), s.datasetKey(), s.activeKey(), s.revisionSequenceKey()}
	for _, name := range sources {
		keys = append(keys, s.stagingSourceKey(token, name), s.sourceHashKey(name))
	}
	// The published dataset itself records source names; an incomplete active
	// status hash must not silently leave retired source keys behind.
	var oldNames []string
	if previous != nil {
		if err := json.Unmarshal([]byte(fmt.Sprint(previous)), &oldNames); err != nil {
			return 0, fmt.Errorf("decode published dataset sources: %w", err)
		}
	}
	sort.Strings(oldNames)
	for _, name := range oldNames {
		keys = append(keys, s.sourceHashKey(name))
	}
	encodedCounts, _ := json.Marshal(counts)
	encodedSources, _ := json.Marshal(sources)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	expected := make([]string, 0, len(sources))
	for _, name := range sources {
		expected = append(expected, strconv.Itoa(counts[name]+1))
	}
	script := `
local base = redis.call("HGET", KEYS[1], "baseRevision")
if not base or base ~= (redis.call("HGET", KEYS[3], "revision") or "0") then
  return redis.error_reply("dataset changed during projection")
end
local n = tonumber(ARGV[1])
for i = 1, n do
  if redis.call("HLEN", KEYS[4 + 2*i - 1]) ~= tonumber(ARGV[6+i]) then
    return redis.error_reply("staged source incomplete")
  end
end
for i = 1, n do
  redis.call("RENAME", KEYS[4 + 2*i - 1], KEYS[4 + 2*i])
  redis.call("PERSIST", KEYS[4 + 2*i])
end
for i = 5 + 2*n, #KEYS do
  local retained = false
  for j = 1, n do
    if KEYS[i] == KEYS[4 + 2*j] then retained = true; break end
  end
  if not retained then redis.call("UNLINK", KEYS[i]) end
end
redis.call("RENAME", KEYS[1], KEYS[2])
redis.call("PERSIST", KEYS[2])
redis.call("HSET", KEYS[2], "sources", ARGV[2])
redis.call("HDEL", KEYS[2], "indexedRevision")
local revision = redis.call("INCR", KEYS[4])
redis.call("HSET", KEYS[3], "revision", revision,
  "dataRevision", ARGV[3], "evaluatedAt", ARGV[4],
  "counts", ARGV[5], "activatedAt", ARGV[6])
return revision`
	command := []string{"EVAL", script, strconv.Itoa(len(keys))}
	command = append(command, keys...)
	command = append(command, strconv.Itoa(len(sources)), string(encodedSources), dataRevision,
		evaluatedAt.UTC().Format(time.RFC3339Nano), string(encodedCounts), now)
	command = append(command, expected...)
	value, err := s.Client.Do(ctx, command...)
	if err != nil {
		return 0, fmt.Errorf("publish dataset: %w", err)
	}
	revision, ok := value.(int64)
	if !ok || revision < 1 {
		return 0, errors.New("invalid dataset publication revision")
	}
	return revision, nil
}

// DatasetRevision is a cheap consistency fence for reads spanning commands.
func (s *Store) DatasetRevision(ctx context.Context) (int64, error) {
	value, err := s.Client.Do(ctx, "HGET", s.activeKey(), "revision")
	if err != nil {
		return 0, err
	}
	if value == nil {
		return 0, ErrSourceUnavailable
	}
	return strconv.ParseInt(fmt.Sprint(value), 10, 64)
}

func (s *Store) StageDiagnostics(ctx context.Context, token string, diagnostics model.Diagnostics) error {
	data, err := json.Marshal(diagnostics)
	if err != nil {
		return err
	}

	return s.stageField(ctx, token, "diagnostics", string(data))
}
func (s *Store) StageRepositoryMemory(ctx context.Context, token string, manifest []byte, files map[string][]byte) error {
	if err := s.stageField(ctx, token, repositoryMemoryManifestField, string(manifest)); err != nil {
		return err
	}
	for name, content := range files {
		campaign, path, ok := strings.Cut(name, "\x00")
		if !ok {
			return errors.New("invalid repository memory file key")
		}
		if err := s.stageField(ctx, token, repositoryMemoryFileField(campaign, path), string(content)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ReadRepositoryMemoryManifest(ctx context.Context) ([]byte, error) {
	raw, err := s.Client.Do(ctx, "HGET", s.datasetKey(), repositoryMemoryManifestField)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, ErrSourceUnavailable
	}
	return []byte(fmt.Sprint(raw)), nil
}

func (s *Store) ReadRepositoryMemoryFile(ctx context.Context, campaign, path string) ([]byte, error) {
	raw, err := s.Client.Do(ctx, "HGET", s.datasetKey(), repositoryMemoryFileField(campaign, path))
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, ErrSourceUnavailable
	}
	return []byte(fmt.Sprint(raw)), nil
}
func (s *Store) ReadDiagnostics(ctx context.Context) (model.Diagnostics, error) {
	raw, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "diagnostics")
	if err != nil {
		return model.Diagnostics{}, err
	}
	if raw == nil {
		return model.Diagnostics{}, ErrSourceUnavailable
	}
	var diagnostics model.Diagnostics
	err = json.Unmarshal([]byte(fmt.Sprint(raw)), &diagnostics)
	return diagnostics, err
}

// ReadSource reads only the named source from the current logical dataset.
// The caller must verify the revision fence after finishing its whole query.
func (s *Store) ReadSource(ctx context.Context, name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	metadataRaw, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "source:"+name+":metadata")
	metrics := model.Metrics{RedisCommands: 1}
	if err != nil {
		return model.Source{}, metrics, err
	}

	if metadataRaw == nil {
		return model.Source{}, metrics, fmt.Errorf("%w: %q", ErrSourceUnavailable, name)
	}
	var metadata model.Metadata
	if err := json.Unmarshal([]byte(fmt.Sprint(metadataRaw)), &metadata); err != nil {
		return model.Source{}, metrics, err
	}
	if metadata == nil {
		metadata = model.Metadata{}
	}
	key := s.sourceHashKey(name)
	if label, field, ok := nativeTableCount(definition); ok && definition.From == name {
		countRaw, err := s.Client.Do(ctx, "HLEN", key)
		metrics.RedisCommands++
		if err != nil {
			return model.Source{}, metrics, err
		}
		count64 := toInt64(countRaw) - 1 // _staged sentinel
		if count64 < 0 {
			return model.Source{}, metrics, ErrSourceUnavailable
		}
		if count64 > int64(^uint(0)>>1) {
			return model.Source{}, metrics, errors.New("source count exceeds platform integer limit")
		}
		count := int(count64)
		var rows []model.Row
		if count != 0 {
			rows = []model.Row{{definition.Compute[0].As: label, field: count}}
		}
		metrics.PushedDown = []string{"compute", "aggregate"}
		return model.Source{Source: name, Metadata: metadata, Rows: rows}, metrics, nil
	}
	if !s.processIsolated && name != "issues" && definition != nil &&
		definition.From == name && len(definition.Union) == 0 &&
		len(definition.Joins) == 0 && definition.Filter == nil &&
		len(definition.Compute) == 0 && definition.TemporalSeries == nil &&
		definition.Aggregate != nil && len(definition.Aggregate.By) > 0 &&
		len(definition.Select) == 0 && len(definition.OrderBy) == 0 && definition.Limit == nil {
		revision, err := s.DatasetRevision(ctx)
		if err != nil {
			return model.Source{}, metrics, err
		}
		values, err := s.Client.Do(ctx, "HMGET", s.datasetKey(),
			"indexedRevision", "source:"+name+":index-schema", "indexedEpoch")
		metrics.RedisCommands += 2
		if err != nil {
			return model.Source{}, metrics, err
		}
		fields, ok := values.([]any)
		if !ok || len(fields) != 3 {
			return model.Source{}, metrics, errors.New("invalid search index metadata")
		}
		if fields[1] != nil {
			var schema []indexField
			if err := json.Unmarshal([]byte(fmt.Sprint(fields[1])), &schema); err != nil {
				return model.Source{}, metrics, err
			}
			eligible := true
			for _, fieldName := range definition.Aggregate.By {
				field, found := findPipelineField(schema, nil, fieldName)
				eligible = eligible && found && field.Required
			}
			for _, value := range definition.Aggregate.Values {
				field, found := findPipelineField(schema, nil, value.Field)
				eligible = eligible && found && field.Required
			}
			if eligible {
				command, output, err := nativeAggregateCommand(s.sourceIndexKey(name), *definition, schema)
				if err == nil {
					if toInt64(fields[0]) != revision || fields[2] == nil {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					rawCount, err := s.Client.Do(ctx, "HLEN", key)
					metrics.RedisCommands++
					if err != nil {
						return model.Source{}, metrics, err
					}
					if toInt64(rawCount)-1 > 10_000 {
						return model.Source{}, metrics, fmt.Errorf("%w: indexed aggregate exceeds input limit", ErrSearchIndexUnavailable)
					}
					result, err := s.Client.Do(ctx, command...)
					metrics.RedisCommands++
					if err != nil {
						return model.Source{}, metrics, fmt.Errorf("%w: %v", ErrSearchIndexUnavailable, err)
					}
					response, valid := result.([]any)
					if !valid || len(response) == 0 {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					count, countOK := response[0].(int64)
					if !countOK || count < 0 || count > query.MaxOutputRows {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					rows, err := decodeAggregateRows(result, output)
					if err != nil || len(rows) != int(count) {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					epoch, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "indexedEpoch")
					metrics.RedisCommands++
					if err != nil || epoch == nil || fmt.Sprint(epoch) != fmt.Sprint(fields[2]) {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					sort.SliceStable(rows, func(i, j int) bool {
						left := make([]any, len(definition.Aggregate.By))
						right := make([]any, len(definition.Aggregate.By))
						for index, field := range definition.Aggregate.By {
							left[index], right[index] = rows[i][field], rows[j][field]
						}
						a, _ := json.Marshal(left)
						b, _ := json.Marshal(right)
						return string(a) < string(b)
					})
					metrics.PushedDown = []string{"aggregate"}
					metrics.RedisRows = len(rows)
					return model.Source{Source: name, Metadata: metadata, Rows: rows}, metrics, nil
				}
			}
		}
	}
	// Go reads remain for source-only requests, issue overlays, process-isolated
	// providers, and query stages the index cannot represent (such as joins,
	// unions, and substring predicates). Eligible indexed reads never take this
	// path merely because an index is missing or rebuilding.
	// Each hash scan page and the retained rows obey the query byte budgets.
	rowsByID := map[string]model.Row{}
	var projectedFields map[string]bool
	if definition != nil && definition.From == name && name != "issues" &&
		len(definition.Union) == 0 && len(definition.Joins) == 0 &&
		definition.Filter == nil && len(definition.Compute) == 0 &&
		definition.TemporalSeries == nil && definition.Aggregate != nil {
		projectedFields = make(map[string]bool)
		for _, field := range definition.Aggregate.By {
			projectedFields[field] = true
		}
		for _, value := range definition.Aggregate.Values {
			if value.Reducer != "count" || value.Filter != nil {
				projectedFields = nil
				break
			}
			projectedFields[value.Field] = true
		}
	}
	workingBytes := int64(0)
	foundMarker := false
	var candidates []string
	var candidateEpoch any
	if !s.processIsolated && name != "issues" && definition != nil &&
		definition.From == name && len(definition.Union) == 0 &&
		len(definition.Joins) == 0 && definition.Filter != nil {
		activeRevision, err := s.DatasetRevision(ctx)
		if err != nil {
			return model.Source{}, metrics, err
		}
		indexed, err := s.Client.Do(ctx, "HMGET", s.datasetKey(),
			"indexedRevision", "source:"+name+":indexed-fields", "indexedEpoch")
		metrics.RedisCommands += 2
		if err != nil {
			return model.Source{}, metrics, err
		}
		fields, ok := indexed.([]any)
		if !ok || len(fields) != 3 {
			return model.Source{}, metrics, errors.New("invalid search index metadata")
		}
		if fields[1] != nil {
			var tags []string
			if err := json.Unmarshal([]byte(fmt.Sprint(fields[1])), &tags); err != nil {
				return model.Source{}, metrics, err
			}
			if expression := indexedPredicate(definition.Filter, tags); expression != "" {
				if toInt64(fields[0]) != activeRevision || fields[2] == nil {
					return model.Source{}, metrics, ErrSearchIndexUnavailable
				}
				result, err := s.Client.Do(ctx, "FT.SEARCH", s.sourceIndexKey(name),
					expression, "NOCONTENT", "LIMIT", "0", strconv.Itoa(maxIndexedCandidates))
				metrics.RedisCommands++
				if err != nil {
					return model.Source{}, metrics, fmt.Errorf("%w: %v", ErrSearchIndexUnavailable, err)
				}
				reply, ok := result.([]any)
				if !ok || len(reply) == 0 {
					return model.Source{}, metrics, ErrSearchIndexUnavailable
				}
				total, validCount := reply[0].(int64)
				if !validCount || total < 0 || total > maxIndexedCandidates || len(reply)-1 != int(total) {
					return model.Source{}, metrics, ErrSearchIndexUnavailable
				}
				names, err := Strings(reply[1:])
				if err != nil {
					return model.Source{}, metrics, ErrSearchIndexUnavailable
				}
				candidates = make([]string, 0, len(names))
				for _, indexedKey := range names {
					id := strings.TrimPrefix(indexedKey, s.indexRowPrefix(name))
					if id == indexedKey || len(id) != 32 {
						return model.Source{}, metrics, ErrSearchIndexUnavailable
					}
					candidates = append(candidates, id)
				}
				metrics.PushedDown = append(metrics.PushedDown, "indexed-candidates")
				candidateEpoch = fields[2]
			}
		}
	}
	if candidates != nil {
		sort.Strings(candidates)
		marker, err := s.Client.Do(ctx, "HGET", key, "_staged")
		metrics.RedisCommands++
		if err != nil || marker == nil {
			return model.Source{}, metrics, ErrSourceUnavailable
		}
		foundMarker = true
		for offset := 0; offset < len(candidates); offset += 32 {
			end := min(len(candidates), offset+32)
			result, err := s.Client.Do(ctx, append([]string{"HMGET", key}, candidates[offset:end]...)...)
			metrics.RedisCommands++
			if err != nil {
				return model.Source{}, metrics, err
			}
			raw, ok := result.([]any)
			if !ok || len(raw) != end-offset {
				return model.Source{}, metrics, errors.New("invalid indexed source response")
			}
			for i, value := range raw {
				if value == nil {
					return model.Source{}, metrics, errors.New("indexed source row is missing")
				}
				content := fmt.Sprint(value)
				workingBytes += int64(len(content))
				if workingBytes > query.MaxWorkingBytes {
					return model.Source{}, metrics, fmt.Errorf("source %q exceeds max working bytes", name)
				}
				var row model.Row
				if err := json.Unmarshal([]byte(content), &row); err != nil {
					return model.Source{}, metrics, err
				}
				rowsByID[candidates[offset+i]] = row
			}
		}
		epoch, err := s.Client.Do(ctx, "HGET", s.datasetKey(), "indexedEpoch")
		metrics.RedisCommands++
		if err != nil {
			return model.Source{}, metrics, err
		}
		if epoch == nil || fmt.Sprint(epoch) != fmt.Sprint(candidateEpoch) {
			return model.Source{}, metrics, ErrSearchIndexUnavailable
		}
	}
	cursor := "0"
	for candidates == nil {
		reply, err := s.boundedSourceScan(ctx, key, cursor)
		metrics.RedisCommands++
		if err != nil {
			return model.Source{}, metrics, err
		}
		parts, ok := reply.([]any)
		if !ok || len(parts) != 2 {
			return model.Source{}, metrics, errors.New("invalid Redis source scan")
		}
		cursor = fmt.Sprint(parts[0])
		fields, err := Strings(parts[1])
		if err != nil || len(fields)%2 != 0 {
			return model.Source{}, metrics, errors.New("invalid Redis source fields")
		}
		for i := 0; i < len(fields); i += 2 {
			if fields[i] == "_staged" {
				foundMarker = true
				continue
			}
			var row model.Row
			if err := json.Unmarshal([]byte(fields[i+1]), &row); err != nil {
				return model.Source{}, metrics, err
			}
			if projectedFields != nil {
				projected := make(model.Row, len(projectedFields))
				for field := range projectedFields {
					if value, ok := row[field]; ok {
						projected[field] = value
					}
				}
				row = projected
				encoded, err := json.Marshal(row)
				if err != nil {
					return model.Source{}, metrics, err
				}
				workingBytes += int64(len(encoded))
			} else {
				workingBytes += int64(len(fields[i+1]))
			}
			if workingBytes > query.MaxWorkingBytes {
				return model.Source{}, metrics, fmt.Errorf("source %q exceeds max working bytes", name)
			}
			rowsByID[fields[i]] = row
			if len(rowsByID) > query.MaxInputRows {
				return model.Source{}, metrics, fmt.Errorf("source %q exceeds max input rows", name)
			}
		}
		if cursor == "0" {
			break
		}
	}
	if !foundMarker {
		return model.Source{}, metrics, fmt.Errorf("%w: %q has no published rows", ErrSourceUnavailable, name)
	}
	ids := make([]string, 0, len(rowsByID))
	for id := range rowsByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	rows := make([]model.Row, 0, len(ids))
	for _, id := range ids {
		rows = append(rows, rowsByID[id])
	}
	metrics.RedisRows = len(rows)
	metrics.FallbackOperations = []string{"query"}
	if name == "issues" {
		if err := s.applyIssueOverlay(ctx, rows, &metrics); err != nil {
			return model.Source{}, metrics, err
		}
	}
	return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
}

func (s *Store) boundedSourceScan(ctx context.Context, key, cursor string) (any, error) {
	return s.Client.Do(ctx, "EVAL", `local page = redis.call("HSCAN", KEYS[1], ARGV[1], "COUNT", 32)
local bytes = 0
for _, field in ipairs(page[2]) do
  bytes = bytes + #field
  if bytes > tonumber(ARGV[2]) then return redis.error_reply("source batch exceeds max working bytes") end
end
return page`, "1", key, cursor, strconv.FormatInt(query.MaxWorkingBytes/2, 10))
}
func (s *Store) applyIssueOverlay(ctx context.Context, rows []model.Row, metrics *model.Metrics) error {
	for offset := 0; offset < len(rows); offset += 32 {
		end := min(len(rows), offset+32)
		var ids []string
		var issues []model.Row
		for _, row := range rows[offset:end] {
			if id, ok := row["id"].(string); ok && id != "" &&
				row["isPullRequest"] == false && !strings.Contains(fmt.Sprint(row["url"]), "/pull/") {
				ids = append(ids, id)
				issues = append(issues, row)
			}
		}
		if len(ids) == 0 {
			continue
		}
		raw, err := s.Client.Do(ctx, append([]string{"HMGET", s.issueStatusKey()}, ids...)...)
		metrics.RedisCommands++
		if err != nil {
			return err
		}
		updates, ok := raw.([]any)
		if !ok || len(updates) != len(ids) {
			return errors.New("invalid issue status response")
		}
		for i, value := range updates {
			if value == nil {
				continue
			}
			var update model.Row
			if err := json.Unmarshal([]byte(fmt.Sprint(value)), &update); err != nil {
				return err
			}
			row := issues[i]
			if update["ambiguous"] == true || update["rowHash"] != rowID(row, 0) ||
				!strings.EqualFold(fmt.Sprint(update["repository"]), fmt.Sprint(row["repositoryFullName"])) {
				continue
			}
			observed, updateErr := time.Parse(time.RFC3339Nano, fmt.Sprint(update["statusObservedAt"]))
			published, publishedErr := time.Parse(time.RFC3339Nano, fmt.Sprint(row["statusObservedAt"]))
			if updateErr != nil || publishedErr == nil && !observed.After(published) {
				continue
			}
			for _, field := range []string{"state", "closed", "stateReason", "closedAt", "statusObservedAt"} {
				row[field] = update[field]
			}
		}
	}
	return nil
}
