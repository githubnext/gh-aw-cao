import path from "node:path";
import { writeFile } from "node:fs/promises";

export async function runHashPayloads({
  options,
  hashActivityPayloads,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "shard-dir", "normalized-dir", "runs-dir", "records-dir", "inventory", "output"]);
  const resolvedOption = (name) => option(options, name, false)
    ? path.resolve(option(options, name, false))
    : undefined;
  const hashes = await hashActivityPayloads({
    databasePath: resolvedOption("database"),
    shardDirectory: resolvedOption("shard-dir"),
    normalizedDirectory: resolvedOption("normalized-dir"),
    runsDirectory: resolvedOption("runs-dir"),
    recordsDirectory: resolvedOption("records-dir"),
    inventoryPath: resolvedOption("inventory"),
  });
  const outputPath = option(options, "output", false);
  if (outputPath) await writeFile(path.resolve(outputPath), `${JSON.stringify(hashes, null, 2)}\n`);
  return hashes;
}
