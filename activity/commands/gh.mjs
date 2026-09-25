export function runGh({
  options,
  indexedDB,
  resource,
  queryGhData,
  UsageError,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "repo", "workflow", "status", "since", "until", "limit"]);
  if (resource !== "runs" && options.status) {
    throw new UsageError("--status is only supported for cao gh runs");
  }
  return queryGhData(indexedDB, resource, options);
}
