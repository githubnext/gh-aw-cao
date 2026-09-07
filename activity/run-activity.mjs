#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";

function importModule(modulePath) {
  return import(pathToFileURL(path.resolve(modulePath)).href);
}

export async function runActivity(actions = {}) {
  const logsModulePath = process.env.ACTIVITY_LOGS;
  const telemetryModulePath = process.env.GITHUB_TELEMETRY;
  const indexerModulePath = process.env.ACTIVITY_INDEXER;
  const dashboardReportRoot = process.env.DASHBOARD_REPORT_ROOT;
  const dashboardCollectionEnabled = process.env.DASHBOARD_COLLECTION === "true";
  const missing = [
    ["ACTIVITY_LOGS", logsModulePath],
    ["GITHUB_TELEMETRY", telemetryModulePath],
    ["ACTIVITY_INDEXER", indexerModulePath],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`);
  }
  if (dashboardCollectionEnabled && !dashboardReportRoot) {
    throw new Error("DASHBOARD_REPORT_ROOT is required when DASHBOARD_COLLECTION is true");
  }

  const [logs, telemetry, indexer] = await Promise.all([
    importModule(logsModulePath),
    importModule(telemetryModulePath),
    importModule(indexerModulePath),
  ]);

  const collectionOutcome = (await logs.main(actions)) || "unknown";

  await telemetry.main(actions, [
    "prepare",
    path.join(process.env.RUNNER_TEMP, "cao-activity", "cao-gh.jsonl"),
  ]);

  try {
    process.env.CAO_OPERATION_OUTCOME = collectionOutcome;
    await telemetry.main(actions, ["after", "collect-gh-aw-logs"]);
  } catch (error) {
    log.warning`Recording GitHub API telemetry for collect-gh-aw-logs failed: ${error instanceof Error ? error.message : error}`;
  }

  if (dashboardCollectionEnabled) {
    const controlSettings = await importModule(path.join(dashboardReportRoot, "control-settings.mjs"));
    await controlSettings.main(actions, [
      ".github/cao/src/control.mjs",
      ".github/workflows/cao.json",
      path.join(process.env.RUNNER_TEMP, "cao-activity", "control-settings.json"),
    ]);

    const inventory = await importModule(path.join(dashboardReportRoot, "inventory.mjs"));
    await inventory.main(actions);
  }

  await indexer.main(actions);

  if (dashboardCollectionEnabled) {
    const collectors = await importModule(path.join(dashboardReportRoot, "activity-collectors.mjs"));
    await collectors.main(actions);
  }
}

export async function main(actions = {}) {
  setActionsGlobals(actions);
  await runActivity(actions);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
