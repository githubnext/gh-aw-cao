// The Go server fixture has no local CLI executor. Only explicitly declared
// capability gates may exclude pages from its query assessment.
export function serverDashboardPageExclusionReason(page) {
  if (page.requires === undefined) return undefined;
  if (page.requires?.capability === "cli-queue") {
    return "Requires the local CLI queue, which the Go Postgres server fixture does not provide";
  }
  throw new Error(`Unknown server dashboard page requirement: ${page.id}`);
}
