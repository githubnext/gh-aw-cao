export function runQuery({
  options,
  indexedDB,
  rawQuery,
  queryRawCanonicalData,
  queryCanonicalData,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "collection", "id", "where", "limit", "stdin"]);
  return rawQuery
    ? queryRawCanonicalData(indexedDB, rawQuery)
    : queryCanonicalData(indexedDB, options);
}
