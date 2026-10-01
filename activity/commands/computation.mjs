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
  rejectUnknownOptions(options, ["database", "inventory", "campaign", "diagnose", "previous", "feedback"]);
  if (!hasComputation(computation)) throw new UsageError(`Unknown computation: ${computation}`);
  if (options.diagnose && !options.campaign) throw new UsageError("--diagnose requires --campaign SLUG");
  if (options.diagnose && computation !== "runtime-health") {
    throw new UsageError("--diagnose is supported only for the runtime-health computation");
  }
  if (options.previous && computation !== "intelligence") {
    throw new UsageError("--previous is supported only for the intelligence computation");
  }
  if (options.feedback && computation !== "intelligence") {
    throw new UsageError("--feedback is supported only for the intelligence computation");
  }
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
  let previousResult;
  if (options.previous) {
    const previousPath = path.resolve(option(options, "previous", false));
    try {
      previousResult = JSON.parse(await readFile(previousPath, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read previous intelligence result ${previousPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let feedback;
  if (options.feedback) {
    const feedbackPath = path.resolve(option(options, "feedback", false));
    try {
      feedback = JSON.parse(await readFile(feedbackPath, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read intelligence feedback ${feedbackPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return queryComputation(indexedDB, computation, {
    campaign: option(options, "campaign", false),
    diagnose: Boolean(options.diagnose),
    inventorySources,
    previousResult,
    feedback,
  });
}
