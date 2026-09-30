import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

model DataState {
  available: boolean;
  rebuildRequired: boolean;
}
model RedisState { connected: boolean; }
@example(#{status: "healthy", redis: #{connected: true}, data: #{available: true, rebuildRequired: false}})
model HealthResponse {
  status: "healthy" | "unhealthy";
  redis: RedisState;
  data: DataState;
  /** Details are present only for an authorized caller. */
  revision?: int64;
  generation?: string;
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
  /** Public liveness and storage health, including when no projection exists. */
  @route("/api/health")
  /** An externally hosted handler also returns an Unavailable error until startup completes or after shutdown. */
  @get op health(): HealthResponse | UnhealthyHealth | Unavailable;

  /** Alias of /api/health. */
  @route("/api/v1/health")
  @get op healthV1(): HealthResponse | UnhealthyHealth | Unavailable;

  /** Public readiness; an empty Redis is healthy but not ready. */
  @route("/api/readiness")
  @get op readiness(): ReadinessResponse | NotReady | Unavailable;
}
