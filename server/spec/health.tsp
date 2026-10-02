import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

model DataState {
  available: boolean;
  rebuildRequired: boolean;
  /** Authoritative source time of the active canonical dataset, when available. */
  evaluatedAt?: utcDateTime;
}
model RedisState { connected: boolean; }
@example(#{
  status: "healthy",
  redis: #{connected: true},
  data: #{
    available: true,
    rebuildRequired: false,
    evaluatedAt: utcDateTime.fromISO("2026-10-02T14:25:38.957Z")
  }
})
model HealthResponse {
  status: "healthy" | "unhealthy";
  redis: RedisState;
  data: DataState;
  /** Details are present only for an authorized caller. */
  revision?: int64;
  counts?: Record<int32>;
  sourceCount?: int32;
  rowCount?: int32;
}
model ReadinessResponse {
  ready: boolean;
  redis: RedisState;
  data: DataState;
}
model UnhealthyHealth {
  @statusCode code: 503;
  @body body: HealthResponse;
}
model NotReady {
  @statusCode code: 503;
  @body body: ReadinessResponse;
}

@tag("Health")
namespace Health {
  /** Public liveness and storage health, including before the first data ingestion. Hosted requests are limited per client address. */
  @route("/api/health")
  /** An externally hosted handler also returns an Unavailable error until startup completes or after shutdown. */
  @get op health(): HealthResponse | UnhealthyHealth | TooManyRequests | Unavailable;

  /** Alias of /api/health. */
  @route("/api/v1/health")
  @get op healthV1(): HealthResponse | UnhealthyHealth | TooManyRequests | Unavailable;

  /** Public readiness; Redis must be connected and Postgres must contain dashboard data. Hosted requests are limited per client address. */
  @route("/api/readiness")
  @get op readiness(): ReadinessResponse | NotReady | TooManyRequests | Unavailable;
}
