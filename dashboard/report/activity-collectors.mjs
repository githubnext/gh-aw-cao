import { collectAicUsage } from "./aic-usage.mjs";
import { collectOperationalValues } from "./operational-values.mjs";
import { writeDashboardRecords } from "./records.mjs";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function collectActivity() {
  await collectAicUsage();
  await collectOperationalValues();
  await writeDashboardRecords();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collectActivity().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
