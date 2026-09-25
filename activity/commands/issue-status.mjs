export function runIssueStatus({
  options,
  indexedDB,
  updateIssueStatuses,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, [
    "database",
    "input-dir",
    "batch-size",
    "graphql-cost-budget",
    "graphql-min-remaining",
  ]);
  return updateIssueStatuses(indexedDB, option(options, "input-dir"), options);
}
