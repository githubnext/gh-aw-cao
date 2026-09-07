#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_RUN_LIMIT = 100;
const ACTIONS_API_CONCURRENCY = 4;

async function existingSnapshot(file) {
  try {
    await stat(file);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { runs: [] };
  }
}

async function writeOutcome(outcome) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `collection-outcome=${outcome}\n`);
  }
}

function runGhAw(targets, outputDirectory, windowDays, runLimit, execute = spawn) {
  return new Promise((resolve, reject) => {
    const child = execute("gh", [
      "aw", "logs", "--json", "--audit",
      "--output", outputDirectory, "--summary-file", "",
      "--artifacts", "usage,detection,evals,experiment,firewall,github-api,graders,mcp",
      "--start-date", `-${windowDays}d`, "--cache-before", `-${windowDays}d`,
      "--count", String(runLimit), "--timeout", "15",
      "--max-github-api-rate-limit", "-2000", "--max-storage", "1200",
      ...targets,
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 50 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0 && !signal) resolve(output);
      else reject(new Error(
        Buffer.concat(stderr).toString("utf8").trim()
          || `gh aw logs exited with ${signal || code}`,
      ));
    });
  });
}

function runGhApi(target, repository, windowStart, runLimit, execute = spawn) {
  const workflow = target.slice(`${repository}/`.length);
  const workflowFile = workflow.split("/").at(-1);
  return new Promise((resolve, reject) => {
    const child = execute("gh", [
      "api", "--method", "GET", `repos/${repository}/actions/workflows/${workflowFile}/runs`,
      "-f", `per_page=${Math.min(runLimit, 100)}`,
      "-f", `created=>=${windowStart}`,
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(
          Buffer.concat(stderr).toString("utf8").trim()
            || `gh api exited with ${signal || code}`,
        ));
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        resolve((response.workflow_runs || []).map((run) => ({
          ...run,
          database_id: run.id,
          workflow_path: workflow,
          started_at: run.run_started_at || run.created_at,
          repository,
        })));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function mergeRunMetadata(cachedRuns, actionRuns) {
  const byRunId = new Map(actionRuns.map((run) => [String(run.database_id), run]));
  for (const cached of cachedRuns) {
    const runId = String(cached.database_id ?? cached.run_id ?? cached.id ?? "");
    const actionRun = byRunId.get(runId);
    if (!actionRun) {
      byRunId.set(runId, cached);
      continue;
    }
    byRunId.set(runId, Object.fromEntries(
      [...new Set([...Object.keys(actionRun), ...Object.keys(cached)])]
        .map((key) => [key, cached[key] === undefined || cached[key] === null || cached[key] === ""
          ? actionRun[key]
          : cached[key]]),
    ));
  }
  return [...byRunId.values()];
}

async function enrichFromActions(targets, repository, windowDays, runLimit, cachedRuns, execute) {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const results = new Array(targets.length);
  let nextTarget = 0;
  const worker = async () => {
    while (nextTarget < targets.length) {
      const index = nextTarget++;
      try {
        results[index] = { status: "fulfilled", value: await runGhApi(targets[index], repository, windowStart, runLimit, execute) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(ACTIONS_API_CONCURRENCY, targets.length) },
    () => worker(),
  ));
  const actionRuns = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return {
    runs: mergeRunMetadata(cachedRuns, actionRuns),
    observedTargets: results.filter((result) => result.status === "fulfilled").length,
    failedTargets: results.filter((result) => result.status === "rejected").length,
  };
}

export async function collectActivityLogs({ execute = spawn } = {}) {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const root = path.resolve(process.env.REPORT_ROOT || ".");
  const logsPath = path.resolve(process.env.REPORT_GH_AW_LOGS || "_activity/gh-aw-logs.json");
  const statePath = path.resolve(process.env.REPORT_GH_AW_LOGS_STATE || "_activity/gh-aw-logs-state.json");
  const outputDirectory = path.resolve(process.env.REPORT_AIC_CACHE || "_activity/gh-aw-logs");
  const windowDays = Number(process.env.REPORT_RUN_WINDOW_DAYS || DEFAULT_WINDOW_DAYS);
  const runLimit = Number(process.env.REPORT_RUN_LIMIT || DEFAULT_RUN_LIMIT);
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) {
    throw new Error("REPORT_RUN_WINDOW_DAYS must be an integer from 1 through 31");
  }
  if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > 1000) {
    throw new Error("REPORT_RUN_LIMIT must be an integer from 1 through 1000");
  }

  await mkdir(outputDirectory, { recursive: true });
  await mkdir(path.dirname(logsPath), { recursive: true });
  await mkdir(path.dirname(statePath), { recursive: true });

  const observedAt = new Date().toISOString();
  const previousState = await readFile(statePath, "utf8").then(JSON.parse).catch(() => ({}));
  let targets = [];
  try {
    const workflowDirectory = path.join(root, ".github", "workflows");
    targets = (await readdir(workflowDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lock.yml"))
      .map((entry) => `${repository}/.github/workflows/${entry.name}`)
      .sort();
    const raw = await runGhAw(targets, outputDirectory, windowDays, runLimit, execute);
    const snapshot = JSON.parse(raw);
    if (!Array.isArray(snapshot.runs)) throw new Error("gh aw logs returned invalid JSON");
    await writeFile(logsPath, `${JSON.stringify(snapshot, null, 2)}\n`);
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
    }, null, 2)}\n`);
    await writeOutcome("success");
    log.info`Downloaded ${snapshot.runs.length} runs for ${targets.length} control-repository workflows with one gh aw logs invocation`;
    return "success";
  } catch (error) {
    const snapshot = await existingSnapshot(logsPath);
    const cachedRuns = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    const enrichment = await enrichFromActions(
      targets,
      repository,
      windowDays,
      runLimit,
      cachedRuns,
      execute,
    );
    const enriched = enrichment.observedTargets > 0;
    const mergedSnapshot = { ...snapshot, runs: enrichment.runs };
    await writeFile(logsPath, `${JSON.stringify(mergedSnapshot, null, 2)}\n`);
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt,
      available: enriched,
      complete: false,
      targetCount: targets.length,
      runCount: enrichment.runs.length,
      windowDays,
      runLimit,
      fallback: cachedRuns.length > 0,
      snapshotObservedAt: previousState.snapshotObservedAt || previousState.observedAt || null,
      actionsEnrichment: enriched,
      actionsTargetsObserved: enrichment.observedTargets,
      actionsTargetsFailed: enrichment.failedTargets,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
  const outcome = enriched ? "partial" : "failure";
  await writeOutcome(outcome);
  log.warning`gh aw logs collection failed; ${enriched ? `enriched the cache with Actions metadata from ${enrichment.observedTargets} workflows` : cachedRuns.length > 0 ? "preserved the cached snapshot" : "wrote an empty snapshot"}: ${error instanceof Error ? error.message : String(error)}`;
  return outcome;
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
