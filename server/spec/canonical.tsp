import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

/** Canonical rows are open objects: source-specific columns are owned by the canonical data schema. */
alias CanonicalRow = JsonObject;

/** Bounded exact cold evidence; absence is an error, never an empty successful history. */
model ToolEventEvidence {
  rows: CanonicalRow[];
  totalEvents: int64;
  returnedEvents: int64;
  omittedEvents: int64;
}

@tag("Canonical entities")
@useAuth(DashboardAuth)
namespace Canonical {
  @route("/api/repositories")
  @get op repositories(): CanonicalRow[] | Unauthorized | Unavailable;

  @route("/api/repositories/{id}")
  @get op repository(@path id: string): CanonicalRow | Unauthorized | NotFound | Unavailable;

  @route("/api/repositories/{id}/runs")
  @get op repositoryRuns(@path id: string): CanonicalRow[] | Unauthorized | NotFound | Unavailable;

  @route("/api/workflows/{id}/runs")
  @get op workflowRuns(@path id: string): CanonicalRow[] | Unauthorized | NotFound | Unavailable;

  @route("/api/runs/{id}/tool-events")
  @get op toolEvents(
    @path id: string,
    @query @minValue(1) @maxValue(2000) limit?: int32 = 20,
    @query type?: string
  ): ToolEventEvidence | BadRequest | Unauthorized | NotFound | Unavailable;
}
