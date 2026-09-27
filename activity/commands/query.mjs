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
  const explicitId = options.collection === undefined && !options.stdin ? options.id : undefined;
  const queryId = positional ?? explicitId;
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
      // `--id` without `--collection` reads a named dashboard query, so say so
      // when the identifier is not one.
      unknownQueryHint: positional === undefined
        ? "pass --collection COLLECTION to read one canonical record by id"
        : undefined,
    });
  }
  rejectUnknownOptions(options, ["database", "collection", "id", "where", "limit", "stdin"]);
  return rawQuery
    ? queryRawCanonicalData(indexedDB, rawQuery)
    : queryCanonicalData(indexedDB, options);
}
