import path from "node:path";

export async function runIngest({
  options,
  indexedDB,
  ingestGhAwLogDirectory,
  databaseCounts,
  retentionWindowMs,
  runRetentionWindowMs,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "context", "logs", "retention-days", "run-retention-days"]);
  const result = await ingestGhAwLogDirectory(
    indexedDB,
    path.resolve(option(options, "context")),
    path.resolve(option(options, "logs")),
    {
      retentionWindowMs: retentionWindowMs(options),
      retentionWindowMsByStore: { runs: runRetentionWindowMs(options) },
    },
  );
  return { result, counts: await databaseCounts(indexedDB) };
}
