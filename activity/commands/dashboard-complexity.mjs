export function runDashboardComplexity({
  options,
  positional,
  analyzeDashboardComplexityFile,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["input", "database", "format", "limit"]);
  const limit = option(options, "limit", false);
  return analyzeDashboardComplexityFile({
    inputPath: option(options, "input"),
    queryId: positional,
    databasePath: option(options, "database", false),
    format: option(options, "format", false) || "json",
    limit: limit === undefined ? undefined : Number(limit),
  });
}
