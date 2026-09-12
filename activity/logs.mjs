#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";
import { parseGhAwLogsJsonl, serializeGhAwLogsJsonl } from "./gh-aw-logs.mjs";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_RUN_LIMIT = 10;
const COLLECTION_STATS_PATTERN =
  /Runs:\s*(\d+)\s*discovered;\s*reports:\s*(\d+)\s*downloaded,\s*(\d+)\s*skipped because cached analyses were reused/;

async function existingSnapshot(file) {
  try {
    await stat(file);
    return { runs: parseGhAwLogsJsonl(await readFile(file, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { runs: [] };
  }
}

async function readCollectionStats(file) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
  const match = COLLECTION_STATS_PATTERN.exec(contents);
  if (!match) return null;
  const discovered = Number(match[1]);
  const downloaded = Number(match[2]);
  const cached = Number(match[3]);
  return { discovered, downloaded, cached, pending: Math.max(0, discovered - downloaded - cached) };
}

async function writeOutcome(outcome) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `collection-outcome=${outcome}\n`);
  }
}

export async function collectActivityLogs() {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const root = path.resolve(process.env.REPORT_ROOT || ".");
  const logsPath = path.resolve(process.env.REPORT_GH_AW_LOGS || "_activity/gh-aw-logs.jsonl");
  const statePath = path.resolve(process.env.REPORT_GH_AW_LOGS_STATE || "_activity/gh-aw-logs-state.json");
  const exitCodePath = path.resolve(process.env.REPORT_GH_AW_LOGS_EXIT_CODE || "_activity/gh-aw-logs-exit-code");
  const stderrPath = path.resolve(process.env.REPORT_GH_AW_LOGS_STDERR || "_activity/gh-aw-logs-stderr.log");
  const windowDays = Number(process.env.REPORT_RUN_WINDOW_DAYS || DEFAULT_WINDOW_DAYS);
  const runLimit = Number(process.env.REPORT_RUN_LIMIT || DEFAULT_RUN_LIMIT);
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) {
    throw new Error("REPORT_RUN_WINDOW_DAYS must be an integer from 1 through 31");
  }
  if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > 200) {
    throw new Error("REPORT_RUN_LIMIT must be an integer from 1 through 200");
  }

  await mkdir(path.dirname(logsPath), { recursive: true });
  await mkdir(path.dirname(statePath), { recursive: true });

  const observedAt = new Date().toISOString();
  const cachedSnapshot = await existingSnapshot(logsPath);
  const cachedRuns = Array.isArray(cachedSnapshot.runs) ? cachedSnapshot.runs : [];
  const previousState = await readFile(statePath, "utf8").then(JSON.parse).catch(() => ({}));
  let targets = [];
  try {
    const workflowDirectory = path.join(root, ".github", "workflows");
    targets = (await readdir(workflowDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lock.yml"))
      .map((entry) => `${repository}/.github/workflows/${entry.name}`)
      .sort();
    const workflowLabel = targets.length === 1 ? "workflow" : "workflows";
    const exitCode = Number((await readFile(exitCodePath, "utf8")).trim());
    if (!Number.isInteger(exitCode) || exitCode !== 0) {
      throw new Error(`gh aw logs exited with ${Number.isInteger(exitCode) ? exitCode : "an unknown status"}`);
    }
    const snapshot = { runs: parseGhAwLogsJsonl(await readFile(logsPath, "utf8")) };
    await writeFile(logsPath, serializeGhAwLogsJsonl(snapshot.runs));
    const collectionStats = await readCollectionStats(stderrPath);
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt,
      available: true,
      complete: true,
      targetCount: targets.length,
      runCount: snapshot.runs.length,
      windowDays,
      runLimit,
      fallback: false,
      ...(collectionStats ? { collectionStats } : {}),
    }, null, 2)}\n`);
    await writeOutcome("success");
    const workflowCount = new Set(snapshot.runs.map((run) => run.workflow_path || run.workflow_name || "unknown")).size;
    const runLabel = snapshot.runs.length === 1 ? "run" : "runs";
    const snapshotWorkflowLabel = workflowCount === 1 ? "workflow" : "workflows";
    log.info`Collected snapshot with ${snapshot.runs.length} ${runLabel} across ${workflowCount} ${snapshotWorkflowLabel}`;
    if (collectionStats) {
      const cachedLabel = collectionStats.cached === 1 ? "run" : "runs";
      const downloadedLabel = collectionStats.downloaded === 1 ? "run" : "runs";
      const pendingLabel = collectionStats.pending === 1 ? "run" : "runs";
      log.info`Loaded ${collectionStats.cached} cached ${cachedLabel} from the --cached-jsonl cache, downloaded ${collectionStats.downloaded} new ${downloadedLabel}, and left ${collectionStats.pending} discovered ${pendingLabel} pending download for ${targets.length} control-repository ${workflowLabel}`;
    } else {
      log.info`Downloaded ${snapshot.runs.length} ${runLabel} for ${targets.length} control-repository ${workflowLabel} with one gh aw logs invocation`;
    }
    return "success";
  } catch (error) {
    await writeFile(logsPath, serializeGhAwLogsJsonl(cachedRuns));
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt,
      available: false,
      complete: false,
      targetCount: targets.length,
      runCount: cachedRuns.length,
      windowDays,
      runLimit,
      fallback: cachedRuns.length > 0,
      snapshotObservedAt: previousState.snapshotObservedAt || previousState.observedAt || null,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    await writeOutcome("failure");
    log.warning`gh aw logs collection failed; ${cachedRuns.length > 0 ? "preserved the cached snapshot" : "wrote an empty snapshot"}: ${error instanceof Error ? error.message : String(error)}`;
    return "failure";
  }
}

export async function main(actions = {}) {
  setActionsGlobals(actions);
  return collectActivityLogs();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
