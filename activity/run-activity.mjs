#!/usr/bin/env node

import path from "node:path";
import { lstat, readdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";

function importModule(modulePath) {
  return import(pathToFileURL(path.resolve(modulePath)).href);
}

async function removeCachedAgentDirectories(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run-\d+$/.test(entry.name)) continue;
    const agentDirectory = path.join(directory, entry.name, "agent");
    const stats = await lstat(agentDirectory).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats?.isDirectory()) continue;
    await rm(agentDirectory, { recursive: true, force: true });
    log.info`Removed cached agent logs from ${entry.name}`;
  }
}

const COLLECT_GH_AW_LOGS_OPERATION = "collect-gh-aw-logs";

// Matches github-telemetry.mjs's fallback so paths stay consistent when
// RUNNER_TEMP is unset (e.g. local/debug runs on non-standard runners).
const runnerTemp = process.env.RUNNER_TEMP || "/tmp";

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

  await removeCachedAgentDirectories(
    path.resolve(process.env.REPORT_AIC_CACHE || "_activity/gh-aw-logs"),
  );
  const collectionOutcome = await logs.main(actions);

  // Preparing telemetry history is required for later recording; let a
  // failure here abort the run, matching the original unprotected step.
  await telemetry.main(actions, [
    "prepare",
    path.join(runnerTemp, "cao-activity", "cao-gh.jsonl"),
  ]);

  // Recording telemetry is best-effort and must not fail the run, matching
  // the original step's continue-on-error behavior.
  try {
    await telemetry.main(actions, ["after", COLLECT_GH_AW_LOGS_OPERATION, collectionOutcome]);
  } catch (error) {
    log.warning`Recording GitHub API telemetry for ${COLLECT_GH_AW_LOGS_OPERATION} failed: ${error instanceof Error ? error.message : error}`;
  }

  if (dashboardCollectionEnabled) {
    const controlSettingsPath =
      process.env.REPORT_CONTROL_SETTINGS || path.join(runnerTemp, "cao-activity", "control-settings.json");
    const controlSettings = await importModule(path.join(dashboardReportRoot, "control-settings.mjs"));
    await controlSettings.main(actions, [".github/cao/src/control.mjs", ".github/workflows/cao.json", controlSettingsPath]);

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
