import "@typespec/http";
import "@typespec/json-schema";

using TypeSpec.Http;
using TypeSpec.JsonSchema;
namespace Cao;

model RebuildStatus {
  state: string;
  required: boolean;
  startedAt?: string;
  completedAt?: string;
  revision?: int64;
  dataRevision?: string;
  counts?: Record<int32>;
}
@jsonSchema
@example(#{accepted: true, duplicate: true})
model WebhookAcknowledgement {
  accepted: true;
  duplicate?: boolean;
  ignored?: boolean;
  reason?: string;
  kind?: string;
  queued?: boolean;
}
model CollectionStatus {
  configured: boolean;
  health: string;
  coverage: { installations: int64; repositories: int64 };
  queueDepth: int64;
  pendingTasks: int64;
  oldestPendingAge?: string;
  deadLetters: int64;
  backfill: string;
  backfillFailures: int32;
  backfillQueuedRunTasks: int32;
  lastProjected?: string;
  counters: Record<int64>;
  /** Half-life 60 seconds: each event contributes one unit, decaying by half every minute. Keys are webhook, collection, and failure. */
  load?: Record<float64>;
  healthRevision: int64;
  lastWebhookAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
  lastSuccessAt?: string;
  rateLimits?: { installationId: int64; remaining: int32; parkedUntil?: string }[];
}
model QuotaBucket { app: string; installation: int64; resource: string; }
model QuotaPoint {
  time: utcDateTime;
  bucket: QuotaBucket;
  limit: int32;
  used: int32;
  reserved: int32;
  usagePercent: float64;
}
model QuotaAggregate {
  time: utcDateTime;
  buckets: int32;
  limit: int32;
  used: int32;
  reserved: int32;
  usagePercent: float64;
}
model QuotaUsage {
  generatedAt: utcDateTime;
  from: utcDateTime;
  intervalSeconds: int32;
  buckets: QuotaPoint[];
  aggregate: QuotaAggregate[];
}
@example(#{timestamp: utcDateTime.fromISO("2026-10-02T19:00:00Z"), `namespace`: "cao:server", message: "listener ready"})
model ServerLogRecord {
  timestamp: utcDateTime;
  `namespace`: string;
  message: string;
}
/** Only fixed, numeric ingestion counters are returned; Redis keys and values are never exposed. */
model ServerLogRedis {
  status: "ok" | "not-configured" | "unavailable";
  counters?: Record<int64>;
  queueDepth?: int64;
  pendingTasks?: int64;
  deadLetters?: int64;
}
@example(#{logs: #[], redis: #{status: "ok", counters: #{webhookReceived: 3}, queueDepth: 0, pendingTasks: 0, deadLetters: 0}})
model ServerLogSnapshot {
  logs: ServerLogRecord[];
  redis: ServerLogRedis;
}

@tag("Ingestion and administration")
namespace Operations {
  /** Public signed GitHub delivery (maximum 10 MiB); validated with HMAC-SHA256 over the raw body. Never use dashboard bearer/session credentials for webhook authentication. The body is a GitHub event-specific JSON object. */
  @route("/api/github/webhook")
  @post op webhook(
    @header("X-Hub-Signature-256") signature: string,
    @header("X-GitHub-Delivery") delivery: string,
    @header("X-GitHub-Event") event: string,
    @body payload: JsonObject
  ): { @statusCode code: 202; @body body: WebhookAcknowledgement } |
    BadRequest | Unauthorized | Conflict | Unavailable;

  /** Start a distributed, asynchronous rebuild; local bearer or hosted admin session and CSRF on hosted mutations. */
  @useAuth(DashboardAuth)
  @route("/api/admin/rebuild")
  @post op rebuild(@header("X-CSRF-Token") csrfToken?: string):
    { @statusCode code: 202; @body body: RebuildStatus } |
    Unauthorized | Forbidden | Conflict | Unavailable;

  @useAuth(DashboardAuth)
  @route("/api/admin/rebuild/status")
  @get op rebuildStatus(): RebuildStatus | Unauthorized | Unavailable;

  /** Administrator-only; returns not-configured when no collector is active. */
  @useAuth(DashboardAuth)
  @route("/api/admin/collection/status")
  @get op collectionStatus(): CollectionStatus | Unauthorized | Forbidden | Unavailable;

  /** Alias for the administrative collection status endpoint. */
  @useAuth(DashboardAuth)
  @route("/api/v1/ingestion/health")
  @get op ingestionHealth(): CollectionStatus | Unauthorized | Forbidden | Unavailable;

  /** Administrator-only retained GitHub API usage; does not expose credentials. */
  @useAuth(DashboardAuth)
  @route("/api/v1/github-quota/usage")
  @get op quotaUsage(): QuotaUsage | Unauthorized | Forbidden | Unavailable;

  /** Available only when CAO_SERVER_LOGS_ENABLED=true. Returns up to 10,000 recent server debug log records and fixed Redis ingestion counters (or availability status); requires a local bearer capability, a hosted administrator session, or the hosted MCP GitHub Actions identity. */
  @useAuth(DashboardAuth)
  @route("/api/admin/logs")
  @get op logs(@header("X-GitHub-Actor") githubActor?: string, @header("X-GitHub-OIDC-Token") githubOIDCToken?: string):
    { @header contentType: "application/json"; @header contentDisposition: "attachment; filename=\"cao-server-logs.json\""; @body body: ServerLogSnapshot } |
    Unauthorized | Forbidden | Unavailable;
}
