import path from "node:path";
import { readFile } from "node:fs/promises";

export async function runIngestJsonl({
  options,
  indexedDB,
  DEFAULT_SHARDS_PATH,
  ingestNormalizedShardDirectories,
  ingestJsonlFile,
  ingestJsonlShardDirectory,
  databaseCounts,
  retentionWindowMs,
  runRetentionWindowMs,
  option,
  rejectUnknownOptions,
  UsageError,
}) {
  rejectUnknownOptions(options, ["database", "input", "input-dir", "runs-dir", "records-dir", "context", "retention-days", "run-retention-days"]);
  const inputPath = option(options, "input", false);
  const inputDirectory = option(options, "input-dir", false);
  if (inputPath && inputDirectory) throw new UsageError("Options --input and --input-dir cannot be combined");
  const contextPath = option(options, "context", false);
  const context = contextPath
    ? JSON.parse(await readFile(path.resolve(contextPath), "utf8"))
    : undefined;
  const ingestOptions = {
    retentionWindowMs: retentionWindowMs(options),
    retentionWindowMsByStore: { runs: runRetentionWindowMs(options) },
    context,
  };
  const runsDirectory = option(options, "runs-dir", false);
  const recordsDirectory = option(options, "records-dir", false);
  if (Boolean(runsDirectory) !== Boolean(recordsDirectory)) {
    throw new Error("--runs-dir and --records-dir must be provided together");
  }
  if ((inputPath || inputDirectory) && runsDirectory) {
    throw new Error("Phased shard directories cannot be combined with --input or --input-dir");
  }
  const result = runsDirectory && recordsDirectory
    ? await ingestNormalizedShardDirectories(indexedDB, [
        ["runs", path.resolve(runsDirectory)],
        ["records", path.resolve(recordsDirectory)],
      ], ingestOptions)
    : inputPath
      ? await ingestJsonlFile(indexedDB, path.resolve(inputPath), ingestOptions)
      : await ingestJsonlShardDirectory(indexedDB, path.resolve(inputDirectory || DEFAULT_SHARDS_PATH), ingestOptions);
  return { result, counts: await databaseCounts(indexedDB) };
}
