import path from "node:path";

export async function runIngest({
  options,
  indexedDB,
  ingestGhAwLogDirectory,
  databaseCounts,
  sqliteRetention,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "context", "logs", "retention-days", "run-retention-days"]);
  const result = await ingestGhAwLogDirectory(
    indexedDB,
    path.resolve(option(options, "context")),
    path.resolve(option(options, "logs")),
    sqliteRetention(options),
  );
  return { result, counts: await databaseCounts(indexedDB) };
}
