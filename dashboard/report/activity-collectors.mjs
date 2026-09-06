import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectAicUsage } from "./aic-usage.mjs";
import { collectOperationalValues } from "./operational-values.mjs";
import { writeDashboardRecords } from "./records.mjs";
import { actionsLog as log } from "../../activity/actions-log.mjs";

let recordTelemetry;

async function telemetry(phase, name, outcome) {
  const script = process.env.GITHUB_TELEMETRY;
  if (!script) return;
  try {
    if (!recordTelemetry) {
      const telemetryModule = await import(pathToFileURL(path.resolve(script)).href);
      if (typeof telemetryModule.recordGithubTelemetry !== "function") {
        throw new Error("GitHub telemetry module does not export recordGithubTelemetry");
      }
      recordTelemetry = telemetryModule.recordGithubTelemetry;
    }
    await recordTelemetry({
      phase,
      operation: name,
      ...(outcome === undefined ? {} : { outcome }),
    });
  } catch {
    // Telemetry must not affect collection.
  }
}

export async function collectActivity() {
  let failed = false;
  for (const [name, collector] of [
    ["aic-usage", collectAicUsage],
    ["operational-values", collectOperationalValues],
    ["dashboard-records", writeDashboardRecords],
  ]) {
    await telemetry("before", `collect-${name}`);
    try {
      await collector();
      await telemetry("after", `collect-${name}`, "success");
    } catch (error) {
      failed = true;
      await telemetry("after", `collect-${name}`, "failure");
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
