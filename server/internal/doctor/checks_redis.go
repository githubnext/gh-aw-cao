package doctor

import (
	"context"
	"fmt"
	"runtime"
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
		// Every read the dashboard serves crosses this link, so a slow round
		// trip is a user-visible latency floor, not a curiosity.
		status = StatusWarn
		summary = fmt.Sprintf("Redis answered PING slowly, in %s", elapsed.Round(time.Millisecond))
		remedy = "check network path and region placement; every dashboard read crosses this link"
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

// checkRedisMemory is the most consequential Redis check.
//
// The canonical database is held entirely in Redis and every projection writes
// a complete new generation. Under an eviction policy Redis silently discards
// rows, which the dashboard renders as missing data rather than as an error.
func (d Doctor) checkRedisMemory(ctx context.Context) Check {
	const id, title = "redis.memory", "Redis memory and eviction policy"
	if skip, ok := d.storeUnavailable(id, areaRedis, title); ok {
		return skip
	}
	fields, err := d.redisInfo(ctx, "memory")
	if err != nil {
		return failed(id, areaRedis, title, err)
	}
	used := infoInt(fields, "used_memory")
	maximum := infoInt(fields, "maxmemory")
	policy := strings.TrimSpace(fields["maxmemory_policy"])
	details := []Detail{
		detail("used", humanBytes(used)),
		detail("usedBytes", fmt.Sprint(used)),
		detail("maxmemory", memoryLimitLabel(maximum)),
		detail("policy", policy),
		detail("fragmentationRatio", fields["mem_fragmentation_ratio"]),
	}
	if maximum > 0 {
		details = append(details, detail("utilization", fmt.Sprintf("%.1f%%", 100*float64(used)/float64(maximum))))
	}
	classification := classifyRedisMemory(used, maximum, policy)
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
			status:  StatusFail,
			summary: fmt.Sprintf("eviction policy is %q; canonical rows can be discarded without an error", policy),
			remedy:  "set maxmemory-policy to noeviction so a full instance fails writes instead of silently dropping rows",
			reason:  memoryReasonEvictingPolicy,
		}
	}
	if maximum > 0 {
		utilization := float64(used) / float64(maximum)
		if utilization >= 0.95 {
			return memoryClassification{
				status:  StatusFail,
				summary: fmt.Sprintf("memory is %.1f%% used; the next projection will probably fail", 100*utilization),
				remedy:  "scale the instance or lower CAO_COLLECT_RETAIN_GENERATIONS so fewer superseded generations are kept",
				reason:  memoryReasonCriticalUtilization,
			}
		}
		if utilization >= 0.80 {
			return memoryClassification{
				status:  StatusWarn,
				summary: fmt.Sprintf("memory is %.1f%% used; a projection writes a full additional generation", 100*utilization),
				remedy:  "headroom below one generation risks a failed projection; scale up or reduce retention",
				reason:  memoryReasonHighUtilization,
			}
		}
	}
	summary := fmt.Sprintf("%s used under a noeviction policy", humanBytes(used))
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

// checkRedisStats reports damage and pressure that may no longer be visible in
// the current memory snapshot. In particular, a past eviction means canonical
// rows may already be missing even if the policy has since been corrected.
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
	if evicted > 0 {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusFail,
			Summary: fmt.Sprintf("Redis has evicted %d keys; the canonical generation may be incomplete", evicted),
			Details: details,
			Remedy:  "set noeviction, then reproject from authoritative evidence; changing the policy does not restore rows already lost",
		}
	}
	if rejected > 0 {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusWarn,
			Summary: fmt.Sprintf("Redis has rejected %d connections since startup", rejected),
			Details: details,
			Remedy:  "inspect connection limits and client churn; rejected connections make reads and projections intermittently fail",
		}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: StatusPass,
		Summary: "no evicted keys or rejected connections since startup",
		Details: details,
	}
}

// checkRedisPersistence reports whether a restart would lose the canonical
// database. Losing it is recoverable -- the evidence lake or a published
// snapshot can repopulate it -- but only if the operator knows to do that.
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
	details := []Detail{
		detail("aofEnabled", fmt.Sprint(aofEnabled)),
		detail("lastBackgroundSave", lastSave),
		detail("changesSinceSave", fields["rdb_changes_since_last_save"]),
	}
	if aofEnabled {
		details = append(details, detail("aofLastWrite", fields["aof_last_write_status"]))
	}
	if lastSave != "" && lastSave != "ok" {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusWarn,
			Summary: "the last background save did not succeed",
			Details: details,
			Remedy:  "inspect the Redis log; a restart would lose the canonical database and require a rebuild",
		}
	}
	if aofEnabled {
		if status := strings.TrimSpace(fields["aof_last_write_status"]); status != "" && status != "ok" {
			return Check{
				ID: id, Area: areaRedis, Title: title, Status: StatusWarn,
				Summary: "the last append-only-file write did not succeed",
				Details: details,
				Remedy:  "inspect the Redis log; persistence is not keeping up with writes",
			}
		}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: StatusPass,
		Summary: "persistence is reporting healthy writes",
		Details: details,
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
	if blocked > 0 {
		// Collection workers block on XREADGROUP, so a blocked client is
		// normal in the collection profile and notable in the Actions profile.
		status := StatusPass
		summary := fmt.Sprintf("%d of %d clients are blocked, which is expected for waiting collection workers", blocked, connected)
		if !d.profile().collecting {
			status = StatusWarn
			summary = fmt.Sprintf("%d of %d clients are blocked with no collection workers configured", blocked, connected)
		}
		return Check{ID: id, Area: areaRedis, Title: title, Status: status, Summary: summary, Details: details}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: StatusPass,
		Summary: fmt.Sprintf("%d client connections, none blocked", connected),
		Details: details,
	}
}

// checkRedisTransport reports how this process reaches Redis. The client
// already refuses plaintext to a non-loopback host, so this reports the posture
// rather than re-validating it.
func (d Doctor) checkRedisTransport(context.Context) Check {
	const id, title = "redis.transport", "Redis transport"
	configured := strings.TrimSpace(d.RedisURL)
	if configured == "" {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusFail,
			Summary: "no Redis URL is configured",
			Remedy:  "pass --redis-url or set CAO_REDIS_URL",
		}
	}
	if _, err := redisx.New(configured); err != nil {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusFail,
			Summary: "the Redis URL is not safe or valid: " + err.Error(),
			Details: []Detail{detail("endpoint", redactRedisURL(configured))},
			Remedy:  "use redis:// only for loopback development; use rediss:// with a verifiable hostname for a remote Redis",
		}
	}
	encrypted := strings.HasPrefix(strings.ToLower(configured), "rediss://")
	details := []Detail{
		detail("endpoint", redactRedisURL(configured)),
		detail("encrypted", fmt.Sprint(encrypted)),
	}
	if encrypted {
		return Check{
			ID: id, Area: areaRedis, Title: title, Status: StatusPass,
			Summary: "connecting over TLS with certificate verification",
			Details: details,
		}
	}
	return Check{
		ID: id, Area: areaRedis, Title: title, Status: StatusPass,
		Summary: "connecting in plaintext to a loopback address, which the client permits only for local development",
		Details: details,
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
