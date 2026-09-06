import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectAicUsage } from "./aic-usage.mjs";
import { collectOperationalValues } from "./operational-values.mjs";
import { writeDashboardRecords } from "./records.mjs";
import { actionsLog as log } from "../../activity/actions-log.mjs";

export async function collectActivity() {
  let failed = false;
  for (const [name, collector] of [
    ["aic-usage", collectAicUsage],
    ["operational-values", collectOperationalValues],
    ["dashboard-records", writeDashboardRecords],
  ]) {
    try {
      await collector();
    } catch (error) {
      failed = true;
      log.error`${name} collection failed: ${error.stack || error.message || error}`;
    }
  }
  if (failed) throw new Error("One or more activity collectors failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collectActivity().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
