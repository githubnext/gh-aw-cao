import "@typespec/http";

using TypeSpec.Http;
namespace Cao;

/** Canonical rows are open objects: source-specific columns are owned by the canonical data schema. */
alias CanonicalRow = JsonObject;

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

  @route("/api/runs/{id}/jobs")
  @get op runJobs(@path id: string): CanonicalRow[] | Unauthorized | Unavailable;

  @route("/api/runs/{id}/sessions")
  @get op runSessions(@path id: string): CanonicalRow[] | Unauthorized | Unavailable;

  @route("/api/sessions/{id}/events")
  @get op sessionEvents(@path id: string): CanonicalRow[] | Unauthorized | Unavailable;
}
