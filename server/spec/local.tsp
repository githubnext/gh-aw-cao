import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

/** The local SQLite preview mounts all paths beneath a random, per-process capability prefix.
 * The prefix is never a GitHub credential. Unexpected Host values fail before routing.
 * Mutations additionally require the exact preview Origin and application/json.
 * These workspace/SDK operations are absent from hosted and published dashboards.
 */
@tag("Local preview")
namespace LocalPreview {
  model JsonResponse<Code extends int32> {
    @statusCode statusCode: Code;
    @body body: JsonObject;
  }
  alias LocalFailure = BadRequest | Forbidden | NotFound | Conflict | Failure<413> | Unavailable;

  @route("/__query_designer")
  @post op generate(
    @header("Origin") origin: string,
    @body body: JsonObject
  ): JsonResponse<200> | LocalFailure | Failure<408>;

  @route("/__query_designer/enhance")
  @post op enhance(
    @header("Origin") origin: string,
    @body body: JsonObject
  ): JsonResponse<200> | LocalFailure | Failure<408>;

  /** Validate and persist a complete Dashboard Language document; the server assigns its path and identity. */
  @route("/__custom_views")
  @post op saveView(
    @header("Origin") origin: string,
    @body body: { document: string }
  ): JsonResponse<201> | LocalFailure;

  @route("/__dialog_selector")
  @post op selector(
    @header("Origin") origin: string,
    @body body: { id: string; text: string }
  ): JsonResponse<200> | LocalFailure | Failure<502>;

  /** Queue only dashboard-declared actions. Canvas execution requires independent trusted-host approval. */
  @route("/__cli_commands")
  @post op enqueue(
    @header("Origin") origin: string,
    @header("Idempotency-Key") idempotencyKey?: string,
    @body body: JsonObject
  ): JsonResponse<202> | LocalFailure;

  @route("/__cli_commands")
  @get op commands(
    @query status?: string,
    @query limit?: int32,
    @query offset?: int32
  ): JsonResponse<200> | LocalFailure;

  @route("/__cli_commands/{id}")
  @get op command(@path id: string): JsonResponse<200> | LocalFailure;

  model OutputStream {
    @statusCode statusCode: 200;
    @header("Content-Type") contentType: "application/x-ndjson; charset=utf-8";
    /** Ordered output records and authoritative command-status updates, followed by a complete record. Disconnecting does not cancel execution. */
    @body body: string;
  }

  @route("/__cli_commands/{id}/output")
  @get op output(@path id: string, @query after?: int64): OutputStream | LocalFailure;

  @route("/__cli_commands/{id}/cancel")
  @post op cancel(
    @path id: string,
    @header("Origin") origin: string,
    @body body: JsonObject
  ): JsonResponse<200> | LocalFailure;

  @route("/__cli_commands/{id}/retry")
  @post op retry(
    @path id: string,
    @header("Origin") origin: string,
    @header("Idempotency-Key") idempotencyKey?: string,
    @body body: JsonObject
  ): JsonResponse<202> | LocalFailure;

  /** Compatibility admission plus output attachment; shares the durable queue and approval boundary. */
  @route("/__cli_action")
  @post op execute(
    @header("Origin") origin: string,
    @header("Idempotency-Key") idempotencyKey?: string,
    @body body: JsonObject
  ): OutputStream | LocalFailure;
}
