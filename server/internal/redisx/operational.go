package redisx

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var _ operational.Store = (*Store)(nil)

func (s *Store) Capabilities() operational.Capabilities {
	shared := operational.Capability{Scope: operational.ScopeDeployment, Persistence: operational.PersistenceRestart}
	local := shared
	if s.ProcessIsolated() {
		local = operational.Capability{Scope: operational.ScopeProcess, Persistence: operational.PersistenceVolatile}
		shared.Scope = operational.ScopeProcess
	}
	collection := local
	if s.ProcessIsolated() {
		collection = operational.Capability{}
	}
	return operational.Capabilities{
		Cache: local, RequestLimits: local, Sessions: local, Revocations: shared,
		GitHubQuota: local, Collection: collection, Coordination: local, Diagnostics: local,
	}
}

func (s *Store) OperationalServices() operational.OperationalServices {
	services := operational.OperationalServices{
		Backend: s, Cache: s, RequestLimiter: s, Sessions: s,
		SessionInvalidator: s, Revocations: s, Leases: s, State: s,
		Deliveries: s, GitHubQuota: s, RateLimits: s, Health: s,
		IngestionMetrics: s,
	}
	if !s.ProcessIsolated() {
		services.Queue, services.Admission, services.Collection = s, s, s
	}
	return services
}

func (s *Store) Health(ctx context.Context) (operational.Health, error) {
	err := s.Ping(ctx)
	return operational.Health{
		Ready: err == nil, Capabilities: s.Capabilities(),
		CacheDisabled: s.cacheCapability.Load() != 0 && !s.DisposableCachesEnabled(),
	}, err
}

func (s *Store) Maintain(ctx context.Context) error {
	maxQueryBytes := s.queryMaintenanceBytes.Load()
	if maxQueryBytes <= 0 {
		maxQueryBytes = 64 << 20
	}
	stats, err := s.MaintainCaches(ctx, maxQueryBytes)
	if !s.DisposableCachesEnabled() {
		storeLog.Printf("disposable caching disabled reason=atomic-memory-introspection-unsupported; protected storage remains enabled")
	}
	if err != nil {
		if !errors.Is(err, ErrMemoryPressure) {
			return err
		}
		return &operational.MaintenanceError{
			UsedBytes: stats.UsedBytes, BudgetBytes: stats.BudgetBytes, Evicted: stats.Evicted, Cause: err,
		}
	}
	return nil
}

func (s *Store) SetQueryMaintenanceBytes(maxBytes int64) error {
	if maxBytes <= 0 {
		return errors.New("query cache maintenance budget must be positive")
	}
	s.queryMaintenanceBytes.Store(maxBytes)
	return nil
}

func (s *Store) Close() error {
	if client, ok := s.Client.(interface{ Close() error }); ok {
		return client.Close()
	}
	return nil
}

func (s *Store) RenewLock(ctx context.Context, name, token string, ttl time.Duration) (bool, error) {
	value, err := s.Client.Do(ctx, "EVAL",
		`if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end; return redis.call("PEXPIRE", KEYS[1], ARGV[2])`,
		"1", s.Key("lock:"+name), token, strconv.FormatInt(ttl.Milliseconds(), 10))
	return value == int64(1), err
}

func (s *Store) AddMembers(ctx context.Context, name string, members ...string) (int64, error) {
	return s.SetAdd(ctx, name, members...)
}
func (s *Store) RemoveMembers(ctx context.Context, name string, members ...string) error {
	return s.SetRemove(ctx, name, members...)
}
func (s *Store) HasMember(ctx context.Context, name, member string) (bool, error) {
	return s.SetContains(ctx, name, member)
}
func (s *Store) MemberCount(ctx context.Context, name string) (int64, error) {
	return s.SetCount(ctx, name)
}
func (s *Store) ScanMembers(ctx context.Context, name, cursor string, count int) ([]string, string, error) {
	return s.SetScan(ctx, name, cursor, count)
}
func (s *Store) ReadAttribute(ctx context.Context, name, field string) (string, error) {
	return s.HashGet(ctx, name, field)
}
func (s *Store) WriteAttribute(ctx context.Context, name, field, value string) error {
	return s.HashSet(ctx, name, field, value)
}
func (s *Store) DeleteAttribute(ctx context.Context, name, field string) error {
	return s.HashDelete(ctx, name, field)
}

func (s *Store) TransferOwners(ctx context.Context, owners, installationPrefix, installationSuffix string, installation int64, repositories []string) (int, error) {
	reads := make([][]string, 0, len(repositories))
	for _, repository := range repositories {
		reads = append(reads, []string{"HGET", s.Key(owners), repository})
	}
	previous, err := s.Client.DoMany(ctx, reads)
	if err != nil {
		return 0, err
	}
	if len(previous) != len(repositories) {
		return 0, errors.New("incomplete enrollment ownership response")
	}
	transferred := 0
	writes := make([][]string, 0, 2*len(repositories))
	for i, repository := range repositories {
		if previous[i] != nil {
			owner, ok := previous[i].(string)
			if !ok {
				return 0, errors.New("invalid enrollment ownership response")
			}
			old, parseErr := strconv.ParseInt(owner, 10, 64)
			if parseErr == nil && old > 0 && old != installation {
				writes = append(writes, []string{"SREM", s.Key(installationPrefix + owner + installationSuffix), repository})
				transferred++
			}
		}
		writes = append(writes, []string{"HSET", s.Key(owners), repository, strconv.FormatInt(installation, 10)})
	}
	if len(writes) != 0 {
		_, err = s.Client.DoMany(ctx, writes)
	}
	return transferred, err
}

func taskFields(fields operational.TaskFields) map[string]string {
	values := map[string]string{"repository": fields.Repository, "task": fields.Task}
	if fields.Key != "" {
		values["key"] = fields.Key
	}
	if fields.Reason != "" {
		values["reason"] = fields.Reason
	}
	if fields.RecordedAt != "" {
		values["recordedAt"] = fields.RecordedAt
	}
	return values
}

func taskMessages(messages []StreamMessage) []operational.TaskMessage {
	result := make([]operational.TaskMessage, 0, len(messages))
	for _, m := range messages {
		result = append(result, operational.TaskMessage{ID: m.ID, Fields: operational.TaskFields{
			Repository: m.Fields["repository"], Task: m.Fields["task"], Key: m.Fields["key"],
			Reason: m.Fields["reason"], RecordedAt: m.Fields["recordedAt"],
		}})
	}
	return result
}

func (s *Store) EnsureQueue(ctx context.Context, queue, group string) error {
	return s.StreamEnsureGroup(ctx, queue, group)
}
func (s *Store) EnqueueTask(ctx context.Context, r operational.EnqueueRequest) (bool, error) {
	return s.StreamEnqueue(ctx, r.Queue, r.Delayed, r.Debounce, r.DebounceTTL, r.Capacity, taskFields(r.Fields))
}
func (s *Store) EnqueueUniqueTask(ctx context.Context, queue, id string, capacity int64, fields operational.TaskFields) (bool, error) {
	return s.StreamEnqueueUnique(ctx, queue, id, capacity, taskFields(fields))
}
func (s *Store) AdmitDelivery(ctx context.Context, r operational.DeliveryRequest) (operational.DeliveryAdmission, error) {
	return s.StreamEnqueueDelivery(ctx, r.Delivery, r.DeliveryTTL, r.Queue, r.Delayed, r.Debounce, r.DebounceTTL, r.Capacity, taskFields(r.Fields))
}
func (s *Store) ReadTasks(ctx context.Context, r operational.QueueRead) ([]operational.TaskMessage, error) {
	messages, err := s.StreamRead(ctx, r.Queue, r.Group, r.Consumer, r.Count, r.Block)
	return taskMessages(messages), err
}
func (s *Store) ClaimTasks(ctx context.Context, r operational.QueueRead, idle time.Duration) ([]operational.TaskMessage, error) {
	messages, _, err := s.StreamClaim(ctx, r.Queue, r.Group, r.Consumer, idle, "0-0", r.Count)
	return taskMessages(messages), err
}
func (s *Store) ReplaceTask(ctx context.Context, r operational.Replacement) error {
	fields := taskFields(r.Fields)
	if !r.Due.IsZero() {
		names := make([]string, 0, len(fields))
		for name := range fields {
			names = append(names, name)
		}
		sort.Strings(names)
		ordered := make([]string, 0, 2*len(names))
		for _, name := range names {
			ordered = append(ordered, name, fields[name])
		}
		member, err := json.Marshal(struct {
			ID     string   `json:"id"`
			Fields []string `json:"fields"`
		}{r.ID, ordered})
		if err != nil {
			return err
		}
		millis := r.Due.UnixMilli()
		if r.Due.Nanosecond()%int(time.Millisecond) != 0 {
			millis++
		}
		return s.StreamScheduleAndAck(ctx, r.Source, r.Group, r.ID, r.Delayed, millis, string(member))
	}
	return s.StreamReplaceAndAck(ctx, r.Source, r.Group, r.ID, r.Destination, r.Capacity, fields)
}
func (s *Store) CompleteTask(ctx context.Context, queue, group, id string) error {
	return s.StreamAckAndDelete(ctx, queue, group, id)
}
func (s *Store) PromoteTasks(ctx context.Context, delayed, queue string, now time.Time, count int) (int64, error) {
	return s.StreamPromoteDue(ctx, delayed, queue, now.UnixMilli(), count)
}
func (s *Store) DelayedDepth(ctx context.Context, delayed string) (int64, error) {
	return s.SortedSetLength(ctx, delayed)
}
func (s *Store) QueueStats(ctx context.Context, queue, group string) (operational.QueueStats, error) {
	length, err := s.StreamLength(ctx, queue)
	stats := operational.QueueStats{Length: length}
	if err != nil || group == "" {
		return stats, err
	}
	stats.Backlog, err = s.StreamBacklog(ctx, queue, group)
	if err != nil {
		return stats, err
	}
	stats.Pending, err = s.StreamPending(ctx, queue, group)
	if err != nil {
		return stats, err
	}
	stats.OldestPendingAge, err = s.StreamOldestPendingAge(ctx, queue, group)
	return stats, err
}

func oauthID(id string) string {
	hash := sha256.Sum256([]byte(id))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}
func (s *Store) sessionRecordKey(id string) string { return s.Key("session:" + oauthID(id)) }
func (s *Store) revocationKeys(prefix, id string) (string, string) {
	if prefix == "" {
		prefix = s.Key("")
	}
	return prefix + "oauth-revocation:" + oauthID(id), prefix + "oauth-revocations"
}
func (s *Store) SessionRecord(ctx context.Context, id string) (string, error) {
	value, err := s.Client.Do(ctx, "GET", s.sessionRecordKey(id))
	if err != nil || value == nil {
		return "", err
	}
	return fmt.Sprint(value), nil
}
func (s *Store) DeleteSession(ctx context.Context, id string) error {
	_, err := s.Client.Do(ctx, "DEL", s.sessionRecordKey(id))
	return err
}
func (s *Store) PutSession(ctx context.Context, id, value string, ttl time.Duration) error {
	_, err := s.Client.Do(ctx, "SET", s.sessionRecordKey(id), value, "EX", fmt.Sprint(int(ttl.Seconds())))
	return err
}
func (s *Store) CompareSession(ctx context.Context, id, expected, value string, ttl time.Duration) (bool, error) {
	const script = `if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1`
	result, err := s.Client.Do(ctx, "EVAL", script, "1", s.sessionRecordKey(id), expected, value, fmt.Sprint(int(ttl.Seconds())))
	return result == int64(1), err
}
func (s *Store) InvalidateSession(ctx context.Context, id, expected, prefix string) (string, error) {
	const script = `local value = redis.call("GET", KEYS[1])
if not value then return false end
if ARGV[1] ~= "" and value ~= ARGV[1] then return "superseded" end
redis.call("SET", KEYS[2], value)
redis.call("SADD", KEYS[3], KEYS[2])
redis.call("DEL", KEYS[1])
return value`
	record, index := s.revocationKeys(prefix, id)
	value, err := s.Client.Do(ctx, "EVAL", script, "3", s.sessionRecordKey(id), record, index, expected)
	if err != nil || value == nil || value == int64(0) {
		return "", err
	}
	if value == "superseded" {
		return "", operational.ErrConflict
	}
	return fmt.Sprint(value), nil
}
func (s *Store) QueueRevocation(ctx context.Context, id, value, prefix string) error {
	record, index := s.revocationKeys(prefix, id)
	_, err := s.Client.Do(ctx, "EVAL", `redis.call("SET", KEYS[1], ARGV[1])
return redis.call("SADD", KEYS[2], KEYS[1])`, "2", record, index, value)
	return err
}
func (s *Store) PendingRevocation(ctx context.Context, prefix string) (operational.Revocation, error) {
	_, index := s.revocationKeys(prefix, "")
	for range 16 {
		key, err := s.Client.Do(ctx, "SRANDMEMBER", index)
		if err != nil || key == nil {
			return operational.Revocation{}, err
		}
		value, err := s.Client.Do(ctx, "GET", fmt.Sprint(key))
		if err != nil {
			return operational.Revocation{}, err
		}
		if value != nil {
			return operational.Revocation{
				ID:    strings.TrimPrefix(fmt.Sprint(key), strings.TrimSuffix(index, "oauth-revocations")+"oauth-revocation:"),
				Value: fmt.Sprint(value),
			}, nil
		}
		if _, err := s.Client.Do(ctx, "SREM", index, fmt.Sprint(key)); err != nil {
			return operational.Revocation{}, err
		}
	}
	return operational.Revocation{}, nil
}
func (s *Store) CompleteRevocation(ctx context.Context, id, expected, prefix string) error {
	record, index := s.revocationKeys(prefix, id)
	_, err := s.Client.Do(ctx, "EVAL", `if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return redis.call("SREM", KEYS[2], KEYS[1])`, "2", record, index, expected)
	return err
}
