export function runOperationalValueCommand({
  options,
  indexedDB,
  databasePath,
  signal,
  runOperationalValue,
  operationalValueReserve,
  REPOSITORY_COORDINATE,
  retentionWindowMs,
  option,
  rejectUnknownOptions,
  UsageError,
}) {
  rejectUnknownOptions(options, ["database", "root", "output", "timestamp", "repository", "retention-days", "max-github-api-rate-limit"]);
  const repositories = options.repository === undefined
    ? []
    : Array.isArray(options.repository) ? options.repository : [options.repository];
  for (const repository of repositories) {
    if (!REPOSITORY_COORDINATE.test(repository)) {
      throw new UsageError("--repository must use OWNER/REPO form");
    }
  }
  return runOperationalValue({
    indexedDB,
    databasePath,
    root: option(options, "root", false) || ".",
    outputPath: option(options, "output", false),
    timestamp: option(options, "timestamp", false) || new Date().toISOString(),
    repositories,
    rateLimitReserve: operationalValueReserve(option(options, "max-github-api-rate-limit", false), UsageError),
    retentionWindow: retentionWindowMs(options),
    signal,
  });
}
