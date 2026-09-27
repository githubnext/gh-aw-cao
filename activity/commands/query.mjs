import { parseNamedQueryParameters, runNamedDashboardQuery } from "../agent-catalog.mjs";

export function runQuery({
  options,
  positional,
  indexedDB,
  rawQuery,
  signal,
  queryRawCanonicalData,
  queryCanonicalData,
  rejectUnknownOptions,
  UsageError,
}) {
  const queryId = positional ?? (options.collection === undefined && !options.stdin ? options.id : undefined);
  if (queryId !== undefined) {
    rejectUnknownOptions(options, ["database", "dashboard", "id", "param", "limit"]);
    if (Array.isArray(queryId)) throw new UsageError("Option --id may only be specified once");
    return runNamedDashboardQuery({
      indexedDB,
      dashboardPath: options.dashboard,
      queryId,
      parameters: parseNamedQueryParameters(options.param),
      limit: options.limit === undefined ? undefined : Number(options.limit),
      signal,
    });
  }
  rejectUnknownOptions(options, ["database", "collection", "id", "where", "limit", "stdin"]);
  return rawQuery
    ? queryRawCanonicalData(indexedDB, rawQuery)
    : queryCanonicalData(indexedDB, options);
}
