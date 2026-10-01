package redisx

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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
const ingestionHealthKey = "state:ingestion-health"

var ingestionCounterNames = map[string]struct{}{
	"webhookReceived":        {},
	"webhookDuplicate":       {},
	"webhookAdmissionFailed": {},
	"taskQueued":             {},
	"taskCoalesced":          {},
	"collectionSucceeded":    {},
	"collectionFailed":       {},
	"collectionRetried":      {},
	"collectionDeadLettered": {},
}

var ingestionLoadNames = map[string]string{
	"webhookReceived":     "webhook",
	"collectionSucceeded": "collection",
	"collectionFailed":    "failure",
}

var ErrSourceUnavailable = errors.New("redis source is unavailable")

type Store struct {
	Client          CommandClient
	namespace       string
	processIsolated bool
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

func NewProcessIsolatedStore(client CommandClient, namespace string) (*Store, error) {
	normalized, err := NormalizeNamespace(namespace)
	if err != nil {
		return nil, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, errors.New("generate process-isolated Redis namespace")
	}
	sum := sha256.Sum256([]byte(normalized))
	isolated, err := NormalizeNamespace(
		"process-" + hex.EncodeToString(sum[:6]) + "-" + hex.EncodeToString(nonce[:]),
	)
	if err != nil {
		return nil, err
	}
	store := NewStore(client, isolated)
	store.processIsolated = true
	return store, nil
}

func (s *Store) ProcessIsolated() bool {
	return s != nil && s.processIsolated
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

// ReserveRateLimit atomically checks and decrements one serialized rate-limit
// state. It returns 1 for a parked installation and 2 for exhausted headroom.
func (s *Store) ReserveRateLimit(
	ctx context.Context, key, field string, floor, cost int, now int64,
) (int, error) {
	script := `
local value = redis.call("HGET", KEYS[1], ARGV[1]) or ""
local remaining, reset, parked = string.match(value, "^(-?%d+)|(-?%d+)|(-?%d+)$")
if not remaining then return 3 end
remaining = tonumber(remaining) or 0
reset = tonumber(reset) or 0
parked = tonumber(parked) or 0
local now = tonumber(ARGV[4])
if parked > now then return 1 end
if reset > 0 and reset < now then
  return 3
end
local floor = tonumber(ARGV[2])
if remaining <= floor then return 2 end
remaining = math.max(remaining - tonumber(ARGV[3]), 0)
redis.call("HSET", KEYS[1], ARGV[1], remaining .. "|" .. reset .. "|" .. parked)
return 0`
	value, err := s.Client.Do(
		ctx, "EVAL", script, "1", s.Key(key), field,
		strconv.Itoa(floor), strconv.Itoa(cost), strconv.FormatInt(now, 10))
	if err != nil {
		return 0, err
	}
	result, err := strconv.Atoi(fmt.Sprint(value))
	if err != nil {
		return 0, errors.New("invalid rate-limit reservation response")
	}
	return result, nil
}

// ObserveRateLimit atomically records authoritative response headroom without
// increasing a same-window value that a concurrent reservation already lowered.
func (s *Store) ObserveRateLimit(
	ctx context.Context, key, field string, remaining int, reset int64,
) error {
	script := `
local value = redis.call("HGET", KEYS[1], ARGV[1]) or ""
local current, current_reset, parked = string.match(value, "^(-?%d+)|(-?%d+)|(-?%d+)$")
current = tonumber(current)
current_reset = tonumber(current_reset)
parked = tonumber(parked) or 0
local observed = tonumber(ARGV[2])
local observed_reset = tonumber(ARGV[3])
if current and current_reset == observed_reset then
  observed = math.min(current, observed)
end
redis.call("HSET", KEYS[1], ARGV[1], observed .. "|" .. observed_reset .. "|" .. parked)
return 0`
	_, err := s.Client.Do(
		ctx, "EVAL", script, "1", s.Key(key), field,
		strconv.Itoa(remaining), strconv.FormatInt(reset, 10))
	return err
}

// ParkRateLimit atomically extends an installation's backoff without changing
// its current headroom.
func (s *Store) ParkRateLimit(
	ctx context.Context, key, field string, parkedTo int64,
) error {
	script := `
local value = redis.call("HGET", KEYS[1], ARGV[1]) or ""
local remaining, reset, parked = string.match(value, "^(-?%d+)|(-?%d+)|(-?%d+)$")
remaining = tonumber(remaining) or 0
reset = tonumber(reset) or 0
parked = math.max(tonumber(parked) or 0, tonumber(ARGV[2]))
redis.call("HSET", KEYS[1], ARGV[1], remaining .. "|" .. reset .. "|" .. parked)
return 0`
	_, err := s.Client.Do(
		ctx, "EVAL", script, "1", s.Key(key), field, strconv.FormatInt(parkedTo, 10))
	return err
}

func (s *Store) RememberDelivery(ctx context.Context, delivery string, ttl time.Duration) (bool, error) {
	value, err := s.Client.Do(ctx, "SET", s.deliveryKey(delivery), "1", "NX", "PX", strconv.FormatInt(ttl.Milliseconds(), 10))
	if err != nil {
		return false, err
	}
	return value != nil && fmt.Sprint(value) == "OK", nil
}

func (s *Store) ForgetDelivery(ctx context.Context, delivery string) error {
	_, err := s.Client.Do(ctx, "DEL", s.deliveryKey(delivery))
	return err
}

type DeliveryReservation int

const (
	DeliveryAlreadyCommitted DeliveryReservation = iota
	DeliveryReserved
	DeliveryInProgress
)

// ReserveDelivery serializes non-queue admission without consuming the
// durable delivery marker before its state changes succeed.
func (s *Store) ReserveDelivery(ctx context.Context, delivery string, ttl time.Duration) (DeliveryReservation, error) {
	script := `
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
if redis.call("SET", KEYS[2], "1", "NX", "PX", ARGV[1]) then return 1 end
return 2`
	value, err := s.Client.Do(
		ctx, "EVAL", script, "2", s.deliveryKey(delivery), s.deliveryReservationKey(delivery),
		strconv.FormatInt(ttl.Milliseconds(), 10),
	)
	if err != nil {
		return DeliveryAlreadyCommitted, err
	}
	switch toInt64(value) {
	case 0:
		return DeliveryAlreadyCommitted, nil
	case 1:
		return DeliveryReserved, nil
	case 2:
		return DeliveryInProgress, nil
	default:
		return DeliveryAlreadyCommitted, errors.New("unexpected delivery reservation response")
	}
}

func (s *Store) ReleaseDeliveryReservation(ctx context.Context, delivery string) error {
	_, err := s.Client.Do(ctx, "DEL", s.deliveryReservationKey(delivery))
	return err
}

func (s *Store) deliveryReservationKey(delivery string) string {
	sum := sha256.Sum256([]byte(delivery))
	return s.Key("github-delivery-reservation:" + hex.EncodeToString(sum[:]))
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

// IncrementIngestionCounter records one bounded, low-cardinality ingestion
// event. Counter names are restricted to the known health contract.
func (s *Store) IncrementIngestionCounter(ctx context.Context, name string) error {
	if _, ok := ingestionCounterNames[name]; !ok {
		return errors.New("unknown ingestion counter")
	}
	if metric, ok := ingestionLoadNames[name]; ok {
		script := `redis.call("HINCRBY", KEYS[1], ARGV[4], 1); redis.call("HINCRBY", KEYS[1], "healthRevision", 1); ` + loadStep
		_, err := s.Client.Do(ctx, "EVAL", script, "2", s.Key(ingestionHealthKey),
			s.Key("load:"+metric), "1", "60", "480", name)
		return err
	}
	script := `local count = redis.call("HINCRBY", KEYS[1], ARGV[1], 1); redis.call("HINCRBY", KEYS[1], "healthRevision", 1); return count`
	_, err := s.Client.Do(ctx, "EVAL", script, "1", s.Key(ingestionHealthKey), name)
	return err
}

// RecordIngestionHealthEvent stores only fixed event codes and timestamps, not
// error messages, request data, or credentials.
func (s *Store) RecordIngestionHealthEvent(ctx context.Context, event, code string, at time.Time) error {
	var field string
	switch event {
	case "failure":
		if code != "admission" && code != "collection" && code != "redis" {
			return errors.New("unknown ingestion failure code")
		}
		field = "lastFailure"
	case "success":
		if code != "" {
			return errors.New("success events must not include a code")
		}
		field = "lastSuccess"
	case "webhook":
		if code != "" {
			return errors.New("webhook events must not include a code")
		}
		field = "lastWebhook"
	default:
		return errors.New("unknown ingestion health event")
	}
	timestamp := at.UTC().Format(time.RFC3339Nano)
	script := `redis.call("HINCRBY", KEYS[1], "healthRevision", 1); redis.call("HSET", KEYS[1], ARGV[1], ARGV[2]); return 1`
	if event == "failure" {
		script = `redis.call("HINCRBY", KEYS[1], "healthRevision", 1); redis.call("HSET", KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4]); return 1`
		_, err := s.Client.Do(ctx, "EVAL", script, "1", s.Key(ingestionHealthKey),
			field+"At", timestamp, field+"Code", code)
		return err
	}
	_, err := s.Client.Do(ctx, "EVAL", script, "1", s.Key(ingestionHealthKey), field+"At", timestamp)
	return err
}

// IngestionHealth returns the bounded health fields persisted by the
// collection pipeline.
func (s *Store) IngestionHealth(ctx context.Context) (map[string]int64, map[string]string, error) {
	value, err := s.Client.Do(ctx, "HGETALL", s.Key(ingestionHealthKey))
	if err != nil {
		return nil, nil, err
	}
	fields, err := Strings(value)
	if err != nil {
		return nil, nil, err
	}
	counters := make(map[string]int64, len(ingestionCounterNames))
	events := make(map[string]string, 5)
	for index := 0; index+1 < len(fields); index += 2 {
		name, value := fields[index], fields[index+1]
		if _, ok := ingestionCounterNames[name]; ok {
			count, parseErr := strconv.ParseInt(value, 10, 64)
			if parseErr != nil || count < 0 {
				return nil, nil, errors.New("invalid ingestion counter")
			}
			counters[name] = count
			continue
		}
		switch name {
		case "lastFailureAt", "lastFailureCode", "lastSuccessAt", "lastWebhookAt", "healthRevision":
			events[name] = value
		}
	}
	return counters, events, nil
}

const repositoryMemoryManifestField = "repository-memory:manifest"

func repositoryMemoryFileField(campaign, path string) string {
	return "repository-memory:file:" + base64.RawURLEncoding.EncodeToString([]byte(campaign+"\x00"+path))
}

func (s *Store) PutRepositoryMemory(ctx context.Context, generation string, manifest []byte, files map[string][]byte) error {
	if _, err := s.Client.Do(ctx, "HSET", s.generationKey(generation), repositoryMemoryManifestField, string(manifest)); err != nil {
		return fmt.Errorf("write repository-memory manifest: %w", err)
	}
	commands := make([][]string, 0, redisWriteBatchSize)
	for key, content := range files {
		campaign, path, found := strings.Cut(key, "\x00")
		if !found {
			return errors.New("repository-memory file key is invalid")
		}
		commands = append(commands, []string{
			"HSET", s.generationKey(generation), repositoryMemoryFileField(campaign, path), string(content),
		})
		if len(commands) == cap(commands) {
			if _, err := s.Client.DoMany(ctx, commands); err != nil {
				return fmt.Errorf("write repository-memory files: %w", err)
			}
			commands = commands[:0]
		}
	}
	if len(commands) > 0 {
		if _, err := s.Client.DoMany(ctx, commands); err != nil {
			return fmt.Errorf("write repository-memory files: %w", err)
		}
	}
	return nil
}

func (s *Store) RepositoryMemoryManifest(ctx context.Context, generation string) ([]byte, error) {
	value, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), repositoryMemoryManifestField)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, ErrSourceUnavailable
	}
	return []byte(fmt.Sprint(value)), nil
}

func (s *Store) RepositoryMemoryFile(ctx context.Context, generation, campaign, path string) ([]byte, error) {
	value, err := s.Client.Do(ctx, "HGET", s.generationKey(generation), repositoryMemoryFileField(campaign, path))
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, ErrSourceUnavailable
	}
	return []byte(fmt.Sprint(value)), nil
}

func repositoryMemoryCacheKey(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CachedRepositoryMemoryCampaign(ctx context.Context, campaign string) ([]byte, error) {
	value, err := s.Client.Do(ctx, "GET", s.Key(
		"repository-memory:campaign:"+repositoryMemoryCacheKey(campaign)))
	if err != nil || value == nil {
		return nil, err
	}
	return []byte(fmt.Sprint(value)), nil
}

func (s *Store) CacheRepositoryMemoryCampaign(
	ctx context.Context, campaign string, content []byte, ttl time.Duration,
) error {
	_, err := s.Client.Do(
		ctx,
		"SET",
		s.Key("repository-memory:campaign:"+repositoryMemoryCacheKey(campaign)),
		string(content),
		"PX",
		strconv.FormatInt(ttl.Milliseconds(), 10),
	)
	return err
}

func (s *Store) CachedRepositoryMemoryFile(
	ctx context.Context, campaign, commit, path string,
) ([]byte, error) {
	value, err := s.Client.Do(ctx, "GET", s.Key(
		"repository-memory:cached-file:"+repositoryMemoryCacheKey(campaign, commit, path)))
	if err != nil || value == nil {
		return nil, err
	}
	return []byte(fmt.Sprint(value)), nil
}

func (s *Store) CacheRepositoryMemoryFile(
	ctx context.Context, campaign, commit, path string, content []byte, ttl time.Duration,
) error {
	_, err := s.Client.Do(
		ctx,
		"SET",
		s.Key("repository-memory:cached-file:"+repositoryMemoryCacheKey(campaign, commit, path)),
		string(content),
		"PX",
		strconv.FormatInt(ttl.Milliseconds(), 10),
	)
	return err
}

func marketplaceCacheKey(registryID, generation string) string {
	return repositoryMemoryCacheKey(registryID, generation)
}

// CachedMarketplaceRegistry returns one registry's cached, already-normalized
// package list for the given dashboard data revision (generation), or nil if
// no entry is cached. The cache key is derived from both registryID and
// generation so results never leak across registries or across revisions.
func (s *Store) CachedMarketplaceRegistry(ctx context.Context, registryID, generation string) ([]byte, error) {
	value, err := s.Client.Do(ctx, "GET", s.Key("marketplace:registry:"+marketplaceCacheKey(registryID, generation)))
	if err != nil || value == nil {
		return nil, err
	}
	return []byte(fmt.Sprint(value)), nil
}

// CacheMarketplaceRegistry stores one registry's normalized package list for
// ttl, isolated by registryID and generation. content must already be safe to
// serve to clients: callers must never cache raw secrets or access tokens.
func (s *Store) CacheMarketplaceRegistry(
	ctx context.Context, registryID, generation string, content []byte, ttl time.Duration,
) error {
	if ttl <= 0 {
		return nil
	}
	_, err := s.Client.Do(
		ctx,
		"SET",
		s.Key("marketplace:registry:"+marketplaceCacheKey(registryID, generation)),
		string(content),
		"PX",
		strconv.FormatInt(ttl.Milliseconds(), 10),
	)
	return err
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
	result, malformed := parseActiveGeneration(fields)
	if malformed > 0 {
		redisLog.Printf("active generation fields malformed=%d", malformed)
	}
	return result, nil
}

// parseActiveGeneration decodes an HGETALL ... reply, which alternates field
// and value strings, into an ActiveGeneration. It is a pure function so
// Active's decoding of a malformed revision, evaluatedAt, counts, or
// activatedAt field is testable without a fake Redis reply. A field that
// fails to parse is left at its zero value, matching the prior inline
// decoding, and counted in the returned malformed total.
func parseActiveGeneration(fields []string) (model.ActiveGeneration, int) {
	result := model.ActiveGeneration{Counts: map[string]int{}}
	malformed := 0
	for i := 0; i+1 < len(fields); i += 2 {
		switch fields[i] {
		case "generation":
			result.Generation = fields[i+1]
		case "revision":
			revision, err := strconv.ParseInt(fields[i+1], 10, 64)
			if err != nil {
				malformed++
				continue
			}
			result.Revision = revision
		case "dataRevision":
			result.DataRevision = fields[i+1]
		case "evaluatedAt":
			evaluatedAt, err := time.Parse(time.RFC3339Nano, fields[i+1])
			if err != nil {
				malformed++
				continue
			}
			result.EvaluatedAt = evaluatedAt
		case "counts":
			if err := json.Unmarshal([]byte(fields[i+1]), &result.Counts); err != nil {
				malformed++
			}
		case "activatedAt":
			activated, err := time.Parse(time.RFC3339Nano, fields[i+1])
			if err != nil {
				malformed++
				continue
			}
			result.Activated = activated
		}
	}
	return result, malformed
}

func (s *Store) Activate(ctx context.Context, generation, dataRevision string, evaluatedAt time.Time, counts map[string]int) (int64, error) {
	redisLog.Printf("activating generation sources=%d", len(counts))
	data, _ := json.Marshal(counts)
	activationTime := time.Now().UTC()
	activated := activationTime.Format(time.RFC3339Nano)
	// The issue overlay is keyed by identity independently of generations;
	// activation never scans or copies issue status.
	script := fmt.Sprintf(issueStatusPruneScript, int64(issueStatusRetention.Seconds())) +
		`prune(KEYS[4], KEYS[5], tonumber(ARGV[6]), ARGV[1], ARGV[7], ARGV[8], ARGV[9]); local revision = redis.call("INCR", KEYS[3]); redis.call("HSET", KEYS[1], "generation", ARGV[1], "revision", revision, "dataRevision", ARGV[2], "evaluatedAt", ARGV[3], "counts", ARGV[4], "activatedAt", ARGV[5]); redis.call("SET", KEYS[2], ARGV[1]); return revision`
	value, err := s.Client.Do(
		ctx, "EVAL", script, "5", s.activeKey(), s.activeGenerationKey(), s.revisionSequenceKey(),
		s.issueStatusKey(), s.issueStatusAgeKey(),
		generation, dataRevision, evaluatedAt.UTC().Format(time.RFC3339Nano), string(data), activated,
		strconv.FormatInt(activationTime.Unix(), 10),
		s.namespace+":g:", ":source:"+safeName("issues")+":row:", ":source:"+safeName("issues")+":rows",
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
// definition, except for unfiltered literal-labelled table counts, which use
// the generation's Redis set cardinality without loading row documents.
//
// There is deliberately no general query pushdown. It required RediSearch, and
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
	if label, field, ok := nativeTableCount(definition); ok {
		value, err := s.Client.Do(ctx, "SCARD", s.sourceSetKey(generation, name))
		metrics := model.Metrics{RedisCommands: 2, PushedDown: []string{"compute", "aggregate"}}
		if err != nil {
			return model.Source{}, metrics, err
		}
		count, err := strconv.Atoi(fmt.Sprint(value))
		if err != nil || count < 0 {
			return model.Source{}, metrics, errors.New("invalid Redis source cardinality")
		}
		rows := []model.Row{}
		if count > 0 {
			rows = append(rows, model.Row{definition.Compute[0].As: label, field: count})
		}
		return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
	}
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
	if name == "issues" {
		// Only request statuses for retained rows; even a large global overlay
		// never requires an unbounded Redis reply or main-thread hash scan.
		for offset := 0; offset < len(rows); offset += batchSize {
			end := min(len(rows), offset+batchSize)
			ids := make([]string, 0, end-offset)
			issueRows := make([]model.Row, 0, end-offset)
			for _, row := range rows[offset:end] {
				if id, ok := row["id"].(string); ok && id != "" &&
					row["isPullRequest"] == false && !strings.Contains(fmt.Sprint(row["url"]), "/pull/") {
					ids = append(ids, id)
					issueRows = append(issueRows, row)
				}
			}
			if len(ids) == 0 {
				continue
			}
			command := append([]string{"HMGET", s.issueStatusKey()}, ids...)
			value, err := s.Client.Do(ctx, command...)
			metrics.RedisCommands++
			if err != nil {
				return model.Source{}, metrics, err
			}
			updates, ok := value.([]any)
			if !ok || len(updates) != len(ids) {
				return model.Source{}, metrics, errors.New("invalid issue status response")
			}
			for i, raw := range updates {
				if raw == nil {
					continue
				}
				var update model.Row
				if err := json.Unmarshal([]byte(fmt.Sprint(raw)), &update); err != nil {
					return model.Source{}, metrics, err
				}
				row := issueRows[i]
				if update["ambiguous"] == true || update["rowHash"] != rowID(row, 0) ||
					!strings.EqualFold(fmt.Sprint(update["repository"]), fmt.Sprint(row["repositoryFullName"])) {
					continue
				}
				observed, updateErr := time.Parse(time.RFC3339Nano, fmt.Sprint(update["statusObservedAt"]))
				snapshot, snapshotErr := time.Parse(time.RFC3339Nano, fmt.Sprint(row["statusObservedAt"]))
				if updateErr != nil || snapshotErr == nil && !observed.After(snapshot) {
					continue
				}
				for _, field := range []string{"state", "closed", "stateReason", "closedAt", "statusObservedAt"} {
					row[field] = update[field]
				}
			}
		}
	}
	metrics.RedisRows = len(rows)
	redisLog.Printf("loaded source rows=%d mode=fallback", len(rows))
	return model.Source{Source: name, Rows: rows, Metadata: metadata}, metrics, nil
}

func nativeTableCount(definition *query.Definition) (any, string, bool) {
	if definition == nil || len(definition.Union) != 0 || len(definition.Joins) != 0 ||
		definition.Filter != nil || definition.TemporalSeries != nil || len(definition.Predict) != 0 ||
		len(definition.Compute) != 1 || definition.Aggregate == nil ||
		len(definition.Aggregate.By) != 1 || len(definition.Aggregate.Values) != 1 {
		return nil, "", false
	}
	computed := definition.Compute[0]
	value := definition.Aggregate.Values[0]
	if computed.Function != "literal" || len(computed.Args) != 1 ||
		computed.Args[0].Field != nil || computed.Args[0].Context != "" ||
		computed.As == "" || definition.Aggregate.By[0] != computed.As ||
		value.Reducer != "count" || value.Filter != nil || value.As == "" || value.As == computed.As {
		return nil, "", false
	}
	return computed.Args[0].Value, value.As, true
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
func (s *Store) issueStatusKey() string    { return s.Key("issue-status") }
func (s *Store) issueStatusAgeKey() string { return s.Key("issue-status:updated") }
