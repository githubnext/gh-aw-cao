package doctor

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	areaRuntime = "runtime"
	areaRedis   = "redis"
)

// checkBuild reports what is actually running. A check-up that does not
// identify the build it inspected cannot be correlated with a deployment.
func (d Doctor) checkBuild(context.Context) Check {
	return Check{
		ID: "runtime.build", Area: areaRuntime, Title: "Build and runtime",
		Status:  StatusPass,
		Summary: fmt.Sprintf("cao-dashboard %s on %s/%s", d.Version, runtime.GOOS, runtime.GOARCH),
		Details: []Detail{
			detail("version", d.Version),
			detail("go", runtime.Version()),
			detail("platform", runtime.GOOS+"/"+runtime.GOARCH),
			detail("canonicalSchemaVersion", fmt.Sprint(model.SchemaVersion)),
			detail("reportSchemaVersion", fmt.Sprint(ReportSchemaVersion)),
		},
	}
}

func (d Doctor) checkRedisConnectivity(ctx context.Context) Check {
	const id, title = "redis.connectivity", "Redis reachable"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	started := time.Now()
	if err := d.Store.Ping(ctx); err != nil {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusFail,
			Summary: "Redis did not answer PING: " + err.Error(),
			Remedy:  "confirm the endpoint, credentials, and that the client address is allowed to connect",
		}
	}
	elapsed := time.Since(started)
	status, summary := StatusPass, fmt.Sprintf("Redis answered PING in %s", elapsed.Round(time.Millisecond))
	remedy := ""
	if elapsed > time.Second {
		// Operational queues and sessions depend on this connection.
		status = StatusWarn
		summary = fmt.Sprintf("Redis answered PING slowly, in %s", elapsed.Round(time.Millisecond))
		remedy = "check network path and region placement; sessions and queues depend on this link"
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: status, Summary: summary, Remedy: remedy,
		Details: []Detail{detail("roundTrip", elapsed.Round(time.Millisecond).String())},
	}
}

func (d Doctor) checkRedisServer(ctx context.Context) Check {
	const id, title = "redis.server", "Redis server"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "server")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	details := []Detail{
		detail("version", fields["redis_version"]),
		detail("mode", fields["redis_mode"]),
		detail("uptimeDays", fields["uptime_in_days"]),
	}
	// A server still loading its dataset answers commands but cannot serve
	// reads, so reporting it as healthy would be wrong.
	if infoInt(fields, "loading") == 1 {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusFail,
			Summary: "Redis is still loading its dataset and cannot serve reads",
			Details: details,
			Remedy:  "wait for loading to finish before treating the deployment as ready",
		}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("Redis %s in %s mode", fields["redis_version"], fields["redis_mode"]),
		Details: details,
	}
}

// checkRedisMemory inspects capacity for operational caches, queues, and sessions.
func (d Doctor) checkRedisMemory(ctx context.Context) Check {
	const id, title = "redis.memory", "Redis memory and eviction policy"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "memory")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	used, err := strconv.ParseInt(fields["used_memory"], 10, 64)
	if err != nil || used < 0 {
		return failed(id, areaRedis, title, errors.New("redis used_memory is missing or invalid"))
	}
	var maximum int64
	limitValue, limitReported := fields["maxmemory"]
	if limitReported {
		maximum, err = strconv.ParseInt(limitValue, 10, 64)
		if err != nil || maximum < 0 {
			return failed(id, areaRedis, title, errors.New("redis maxmemory is invalid"))
		}
	}
	budget, err := d.Store.EffectiveMaxMemoryBytes(maximum)
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	policy := strings.TrimSpace(fields["maxmemory_policy"])
	providerLimit := memoryLimitLabel(maximum)
	if !limitReported {
		providerLimit = "not reported"
	}
	details := []Detail{
		detail("used", humanBytes(used)),
		detail("usedBytes", fmt.Sprint(used)),
		detail("maxmemory", providerLimit),
		detail("providerMemoryLimitReported", strconv.FormatBool(limitReported)),
		detail("configuredCachePressureBudgetBytes", fmt.Sprint(d.Store.MaxMemoryBytes())),
		detail("cachePressureBudgetBytes", fmt.Sprint(budget)),
		detail("cachePressureUtilization", fmt.Sprintf("%.1f%%", 100*float64(used)/float64(budget))),
		detail("policy", policy),
		detail("fragmentationRatio", fields["mem_fragmentation_ratio"]),
	}
	if maximum > 0 {
		details = append(details, detail("utilization", fmt.Sprintf("%.1f%%", 100*float64(used)/float64(maximum))))
	}
	classification := classifyRedisMemory(used, maximum, policy)
	if !limitReported && classification.reason == memoryReasonNoLimit {
		classification.reason = memoryReasonUnknownLimit
		classification.summary = "provider memory limit is not reported; the configured CAO cache-pressure budget applies"
		classification.remedy = "verify capacity in the provider management plane and set CAO_REDIS_MAX_BYTES consistently across all roles"
	}
	if used > budget {
		classification.status = StatusFail
		classification.reason = memoryReasonCachePressure
		classification.summary = fmt.Sprintf("memory usage %s exceeds the effective CAO cache-pressure budget %s",
			humanBytes(used), humanBytes(budget))
		classification.remedy = "reclaim disposable caches; if protected state still exceeds the budget, scale Redis and raise CAO_REDIS_MAX_BYTES consistently across all roles"
	}
	doctorLog.Printf("redis memory classified status=%s reason=%s", classification.status, classification.reason)
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}

// memoryClassificationReason names why checkRedisMemory reached its status,
// stable across summary wording changes so it is useful to log without
// exposing the summary's interpolated byte counts.
type memoryClassificationReason string

const (
	memoryReasonEvictingPolicy      memoryClassificationReason = "evicting-policy"
	memoryReasonCriticalUtilization memoryClassificationReason = "critical-utilization"
	memoryReasonHighUtilization     memoryClassificationReason = "high-utilization"
	memoryReasonNoLimit             memoryClassificationReason = "no-limit"
	memoryReasonHealthy             memoryClassificationReason = "healthy"
	memoryReasonCachePressure       memoryClassificationReason = "cache-pressure"
	memoryReasonUnknownLimit        memoryClassificationReason = "unknown-provider-limit"
)

// memoryClassification is the status, summary, and remedy classifyRedisMemory
// derives from Redis's reported memory usage.
type memoryClassification struct {
	status  Status
	summary string
	remedy  string
	reason  memoryClassificationReason
}

// classifyRedisMemory decides the redis.memory check's outcome from Redis's
// reported memory fields alone. It is a pure function so every threshold —
// an evicting policy, each utilization band, and an unbounded instance — is
// testable without a fake Redis INFO reply.
func classifyRedisMemory(used, maximum int64, policy string) memoryClassification {
	if policy != "" && policy != "noeviction" {
		return memoryClassification{
			status:  StatusWarn,
			summary: fmt.Sprintf("eviction policy is %q; sessions or queued work may be discarded", policy),
			remedy:  "review eviction policy and isolate operational queues and sessions from evictable caches",
			reason:  memoryReasonEvictingPolicy,
		}
	}
	if maximum > 0 {
		utilization := float64(used) / float64(maximum)
		if utilization >= 0.95 {
			return memoryClassification{
				status:  StatusFail,
				summary: fmt.Sprintf("memory is %.1f%% used; operational writes may fail", 100*utilization),
				remedy:  "scale the Redis instance or reduce cache pressure",
				reason:  memoryReasonCriticalUtilization,
			}
		}
		if utilization >= 0.80 {
			return memoryClassification{
				status:  StatusWarn,
				summary: fmt.Sprintf("memory is %.1f%% used; operational writes have limited headroom", 100*utilization),
				remedy:  "scale the Redis instance or reduce cache pressure",
				reason:  memoryReasonHighUtilization,
			}
		}
	}
	summary := fmt.Sprintf("%s used for operational state", humanBytes(used))
	if maximum <= 0 {
		// Without a limit Redis grows until the host runs out, which fails far
		// less gracefully than a configured limit.
		return memoryClassification{
			status:  StatusWarn,
			summary: summary + ", with no maxmemory configured",
			remedy:  "configure maxmemory so growth fails predictably instead of exhausting the host",
			reason:  memoryReasonNoLimit,
		}
	}
	return memoryClassification{status: StatusPass, summary: summary, reason: memoryReasonHealthy}
}

func memoryLimitLabel(maximum int64) string {
	if maximum <= 0 {
		return "unlimited"
	}
	return humanBytes(maximum)
}

// statsClassificationReason names why checkRedisStats reached its status,
// stable across summary wording changes so it is useful to log without
// exposing the raw evicted-key or rejected-connection counts.
type statsClassificationReason string

const (
	statsReasonEvictedKeys         statsClassificationReason = "evicted-keys"
	statsReasonRejectedConnections statsClassificationReason = "rejected-connections"
	statsReasonHealthy             statsClassificationReason = "healthy"
)

// statsClassification is the status, summary, and remedy classifyRedisStats
// derives from Redis's reported operational counters.
type statsClassification struct {
	status  Status
	summary string
	remedy  string
	reason  statsClassificationReason
}

// classifyRedisStats decides the redis.stats check's outcome from Redis's
// reported eviction and rejection counters alone. It is a pure function so
// each path -- evicted keys and rejected connections -- is testable without
// a fake Redis INFO reply. Evicted keys are checked first, matching the
// prior inline behavior: an eviction is the more consequential signal
// because it means canonical rows may already be missing.
func classifyRedisStats(evicted, rejected int64) statsClassification {
	if evicted > 0 {
		return statsClassification{
			status:  StatusFail,
			summary: fmt.Sprintf("Redis has evicted %d keys; sessions or queued work may be incomplete", evicted),
			remedy:  "inspect eviction policy and restore affected operational state as needed",
			reason:  statsReasonEvictedKeys,
		}
	}
	if rejected > 0 {
		return statsClassification{
			status:  StatusWarn,
			summary: fmt.Sprintf("Redis has rejected %d connections since startup", rejected),
			remedy:  "inspect connection limits and client churn; rejected connections interrupt sessions and queues",
			reason:  statsReasonRejectedConnections,
		}
	}
	return statsClassification{
		status:  StatusPass,
		summary: "no evicted keys or rejected connections since startup",
		reason:  statsReasonHealthy,
	}
}

// checkRedisStats reports damage and pressure that may no longer be visible in
// the current memory snapshot. A past eviction may have affected operational state.
func (d Doctor) checkRedisStats(ctx context.Context) Check {
	const id, title = "redis.stats", "Redis operational counters"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "stats")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	evicted := infoInt(fields, "evicted_keys")
	rejected := infoInt(fields, "rejected_connections")
	errors := infoInt(fields, "total_error_replies")
	details := []Detail{
		detail("evictedKeys", fmt.Sprint(evicted)),
		detail("rejectedConnections", fmt.Sprint(rejected)),
		detail("errorReplies", fmt.Sprint(errors)),
		detail("operationsPerSecond", fields["instantaneous_ops_per_sec"]),
		detail("keyspaceHits", fields["keyspace_hits"]),
		detail("keyspaceMisses", fields["keyspace_misses"]),
	}
	classification := classifyRedisStats(evicted, rejected)
	doctorLog.Printf("redis stats classified status=%s reason=%s", classification.status, classification.reason)
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}

// persistenceClassificationReason names why checkRedisPersistence reached its
// status, stable across summary wording changes so it is useful to log
// without exposing the raw Redis persistence status strings.
type persistenceClassificationReason string

const (
	persistenceReasonBackgroundSaveFailed persistenceClassificationReason = "background-save-failed"
	persistenceReasonAOFWriteFailed       persistenceClassificationReason = "aof-write-failed"
	persistenceReasonHealthy              persistenceClassificationReason = "healthy"
)

// persistenceClassification is the status, summary, and remedy
// classifyRedisPersistence derives from Redis's reported persistence fields.
type persistenceClassification struct {
	status  Status
	summary string
	remedy  string
	reason  persistenceClassificationReason
}

// classifyRedisPersistence decides the redis.persistence check's outcome
// from Redis's reported persistence fields alone. It is a pure function so
// each failure path -- a failed background save and a failed append-only-file
// write -- is testable without a fake Redis INFO reply. A background-save
// failure is checked first, matching the prior inline behavior.
func classifyRedisPersistence(lastSave string, aofEnabled bool, aofLastWrite string) persistenceClassification {
	if lastSave != "" && lastSave != "ok" {
		return persistenceClassification{
			status:  StatusWarn,
			summary: "the last background save did not succeed",
			remedy:  "inspect the Redis log; a restart may lose queued work or sessions",
			reason:  persistenceReasonBackgroundSaveFailed,
		}
	}
	if aofEnabled && aofLastWrite != "" && aofLastWrite != "ok" {
		return persistenceClassification{
			status:  StatusWarn,
			summary: "the last append-only-file write did not succeed",
			remedy:  "inspect the Redis log; persistence is not keeping up with writes",
			reason:  persistenceReasonAOFWriteFailed,
		}
	}
	return persistenceClassification{
		status:  StatusPass,
		summary: "persistence is reporting healthy writes",
		reason:  persistenceReasonHealthy,
	}
}

// checkRedisPersistence reports whether a restart could lose operational state.
func (d Doctor) checkRedisPersistence(ctx context.Context) Check {
	const id, title = "redis.persistence", "Redis persistence"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "persistence")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	aofEnabled := infoInt(fields, "aof_enabled") == 1
	lastSave := strings.TrimSpace(fields["rdb_last_bgsave_status"])
	aofLastWrite := strings.TrimSpace(fields["aof_last_write_status"])
	details := []Detail{
		detail("aofEnabled", fmt.Sprint(aofEnabled)),
		detail("lastBackgroundSave", lastSave),
		detail("changesSinceSave", fields["rdb_changes_since_last_save"]),
	}
	if aofEnabled {
		details = append(details, detail("aofLastWrite", aofLastWrite))
	}
	classification := classifyRedisPersistence(lastSave, aofEnabled, aofLastWrite)
	doctorLog.Printf("redis persistence classified status=%s reason=%s", classification.status, classification.reason)
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}

// clientsClassificationReason names why checkRedisClients reached its
// status, stable across summary wording changes so it is useful to log
// without exposing the connected or blocked client counts.
type clientsClassificationReason string

const (
	clientsReasonBlockedExpected   clientsClassificationReason = "blocked-expected"
	clientsReasonBlockedUnexpected clientsClassificationReason = "blocked-unexpected"
	clientsReasonNoneBlocked       clientsClassificationReason = "none-blocked"
)

// clientsClassification is the status and summary classifyRedisClients
// derives from Redis's reported client counters and whether this profile
// expects collection workers to hold a blocking connection.
type clientsClassification struct {
	status  Status
	summary string
	reason  clientsClassificationReason
}

// classifyRedisClients decides the redis.clients check's outcome from
// Redis's reported connected and blocked client counts, plus whether the
// current profile expects collection workers to block on XREADGROUP. It is
// a pure function so each path is testable without a fake Redis INFO reply
// or a configured Doctor profile.
func classifyRedisClients(connected, blocked int64, collecting bool) clientsClassification {
	if blocked > 0 {
		if collecting {
			return clientsClassification{
				status:  StatusPass,
				summary: fmt.Sprintf("%d of %d clients are blocked, which is expected for waiting collection workers", blocked, connected),
				reason:  clientsReasonBlockedExpected,
			}
		}
		return clientsClassification{
			status:  StatusWarn,
			summary: fmt.Sprintf("%d of %d clients are blocked with no collection workers configured", blocked, connected),
			reason:  clientsReasonBlockedUnexpected,
		}
	}
	return clientsClassification{
		status:  StatusPass,
		summary: fmt.Sprintf("%d client connections, none blocked", connected),
		reason:  clientsReasonNoneBlocked,
	}
}

func (d Doctor) checkRedisClients(ctx context.Context) Check {
	const id, title = "redis.clients", "Redis clients"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "clients")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	connected := infoInt(fields, "connected_clients")
	blocked := infoInt(fields, "blocked_clients")
	details := []Detail{
		detail("connected", fmt.Sprint(connected)),
		detail("blocked", fmt.Sprint(blocked)),
	}
	classification := classifyRedisClients(connected, blocked, d.profile().collecting)
	doctorLog.Printf("redis clients classified status=%s reason=%s", classification.status, classification.reason)
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details,
	}
}

// redisTransportReason names why checkRedisTransport reached its status,
// stable across summary wording changes so it is useful to log without
// exposing the configured Redis URL.
type redisTransportReason string

const (
	redisTransportReasonUnconfigured redisTransportReason = "unconfigured"
	redisTransportReasonInvalid      redisTransportReason = "invalid"
	redisTransportReasonEncrypted    redisTransportReason = "encrypted"
	redisTransportReasonPlaintext    redisTransportReason = "plaintext-loopback"
)

// redisTransportClassification is the status, summary, remedy, and reason
// classifyRedisTransport derives from a configured Redis URL.
type redisTransportClassification struct {
	status  Status
	summary string
	remedy  string
	reason  redisTransportReason
}

// classifyRedisTransport decides the redis.transport check's outcome from
// the configured URL and whether redisx.New accepts it. redisx.New already
// refuses plaintext to a non-loopback host, so this reports the posture
// rather than re-validating it. It is a pure function so each outcome is
// testable without constructing a Doctor or a live Redis client.
func classifyRedisTransport(configured string, newErr error) redisTransportClassification {
	if configured == "" {
		return redisTransportClassification{
			status:  StatusFail,
			summary: "no Redis URL is configured",
			remedy:  "pass --redis-url or set CAO_REDIS_URL",
			reason:  redisTransportReasonUnconfigured,
		}
	}
	if newErr != nil {
		return redisTransportClassification{
			status:  StatusFail,
			summary: "the Redis URL is not safe or valid: " + newErr.Error(),
			remedy:  "use redis:// only for loopback development; use rediss:// with a verifiable hostname for a remote Redis",
			reason:  redisTransportReasonInvalid,
		}
	}
	if strings.HasPrefix(strings.ToLower(configured), "rediss://") {
		return redisTransportClassification{
			status:  StatusPass,
			summary: "connecting over TLS with certificate verification",
			reason:  redisTransportReasonEncrypted,
		}
	}
	return redisTransportClassification{
		status:  StatusPass,
		summary: "connecting in plaintext to a loopback address, which the client permits only for local development",
		reason:  redisTransportReasonPlaintext,
	}
}

// checkRedisTransport reports how this process reaches Redis.
func (d Doctor) checkRedisTransport(context.Context) Check {
	const id, title = "redis.transport", "Redis transport"
	configured := strings.TrimSpace(d.RedisURL)
	_, newErr := redisx.New(configured)
	classification := classifyRedisTransport(configured, newErr)
	doctorLog.Printf("redis transport classified status=%s reason=%s", classification.status, classification.reason)
	if classification.reason == redisTransportReasonUnconfigured {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: classification.status,
			Summary: classification.summary, Remedy: classification.remedy,
		}
	}
	details := []Detail{detail("endpoint", redactRedisURL(configured))}
	if classification.reason != redisTransportReasonInvalid {
		details = append(details, detail("encrypted", fmt.Sprint(classification.reason == redisTransportReasonEncrypted)))
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}

// foreignNamespacesOf collects the top-level namespace prefixes present in
// keys that are not scoped to namespace, sorted for stable rendering. It is a
// pure function so checkRedisNamespace's "other namespaces sharing the
// instance" detail is testable without a fake Redis SCAN reply.
func foreignNamespacesOf(namespace string, keys []string) []string {
	others := map[string]struct{}{}
	for _, key := range keys {
		if strings.HasPrefix(key, namespace+":") {
			continue
		}
		if prefix, _, found := strings.Cut(key, ":"); found {
			others[prefix] = struct{}{}
		}
	}
	return sortedKeys(others)
}

// namespaceClassificationReason names why checkRedisNamespace reached its
// status, stable across summary wording changes so it is useful to log
// without exposing the namespace or key count.
type namespaceClassificationReason string

const (
	namespaceReasonEmpty     namespaceClassificationReason = "empty"
	namespaceReasonPopulated namespaceClassificationReason = "populated"
)

// namespaceClassification is the status, summary, remedy, and key-count
// label classifyRedisNamespace derives from a namespace's observed key
// count.
type namespaceClassification struct {
	status     Status
	summary    string
	remedy     string
	reason     namespaceClassificationReason
	countLabel string
}

// classifyRedisNamespace decides the redis.namespace check's outcome from
// the namespace, its observed key count, and whether that count is a
// complete scan or a bounded sample. It is a pure function so the
// empty-namespace warning is testable without a fake Redis SCAN reply.
func classifyRedisNamespace(namespace string, keyCount int, complete bool) namespaceClassification {
	countLabel := fmt.Sprint(keyCount)
	if !complete {
		countLabel = fmt.Sprintf("at least %d (sampled)", keyCount)
	}
	if keyCount == 0 {
		return namespaceClassification{
			status:     StatusWarn,
			summary:    fmt.Sprintf("namespace %q holds no keys", namespace),
			remedy:     "confirm --redis-namespace matches the writer; an empty namespace looks identical to an empty database",
			reason:     namespaceReasonEmpty,
			countLabel: countLabel,
		}
	}
	return namespaceClassification{
		status:     StatusPass,
		summary:    fmt.Sprintf("namespace %q holds %s keys", namespace, countLabel),
		reason:     namespaceReasonPopulated,
		countLabel: countLabel,
	}
}

// checkRedisNamespace confirms this process is looking where the data is. A
// namespace mismatch presents exactly like an empty database, so naming it
// explicitly saves a long misdiagnosis.
func (d Doctor) checkRedisNamespace(ctx context.Context) Check {
	const id, title = "redis.namespace", "Redis namespace"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	const sampleLimit = 20000
	keys, complete, err := d.scanKeys(ctx, d.Namespace+":*", sampleLimit)
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	classification := classifyRedisNamespace(d.Namespace, len(keys), complete)
	doctorLog.Printf("redis namespace classified status=%s reason=%s", classification.status, classification.reason)
	details := []Detail{
		detail("namespace", d.Namespace),
		detail("keys", classification.countLabel),
	}
	// Other namespaces sharing the instance are legitimate, but naming them is
	// what turns an empty-namespace report into a diagnosis: they are the
	// usual explanation for a namespace that looks like an empty database.
	foreign, _, foreignErr := d.scanKeys(ctx, "*", 2000)
	if foreignErr == nil {
		if others := foreignNamespacesOf(d.Namespace, foreign); len(others) > 0 {
			details = append(details, detail("otherNamespaces", strings.Join(others, ", ")))
		}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: classification.status,
		Summary: classification.summary, Details: details, Remedy: classification.remedy,
	}
}
