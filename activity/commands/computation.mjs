import path from "node:path";
import { readFile } from "node:fs/promises";

export async function runComputation({
  options,
  indexedDB,
  databasePath,
  computation,
  hasComputation,
  queryComputation,
  option,
  rejectUnknownOptions,
  UsageError,
}) {
  rejectUnknownOptions(options, ["database", "inventory", "campaign", "diagnose"]);
  if (!hasComputation(computation)) throw new UsageError(`Unknown computation: ${computation}`);
  if (options.diagnose && !options.campaign) throw new UsageError("--diagnose requires --campaign SLUG");
  const inventoryPath = path.resolve(
    option(options, "inventory", false)
      || path.join(path.dirname(path.resolve(databasePath)), "inventory-sources.json"),
  );
  let inventorySources;
  try {
    inventorySources = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Runtime health requires campaign inventory: ${inventoryPath}. Run "cao download" first or pass --inventory FILE.`);
    }
    throw new Error(`Unable to read computation inventory ${inventoryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return queryComputation(indexedDB, computation, {
    campaign: option(options, "campaign", false),
    diagnose: Boolean(options.diagnose),
    inventorySources,
  });
}
