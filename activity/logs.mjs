#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";
import { performanceJobRecord } from "./failure-evidence.mjs";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_RUN_LIMIT = 100;
const ACTIONS_API_CONCURRENCY = 4;
const ACTIONS_JOB_PAGE_LIMIT = 10;

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

function shellQuote(argument) {
  if (argument === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function runGhAw(targets, outputDirectory, cachedJsonPath, windowDays, runLimit, execute = spawn) {
  return new Promise((resolve, reject) => {
    const args = [
      "aw", "logs", "--json", "--audit",
      "--output", outputDirectory, "--summary-file", "", "--cached-json", cachedJsonPath,
      "--artifacts", "usage,detection,evals,experiment,firewall,github-api,graders,mcp,agent",
      "--start-date", `-${windowDays}d`, "--cache-before", `-${windowDays}d`,
      "--count", String(runLimit), "--timeout", "25",
      "--max-github-api-rate-limit", "-2000", "--max-storage", "1200", "--prune-older-runs",
      ...targets,
    ];
    log.info`Calling command: ${["gh", ...args].map(shellQuote).join(" ")}`;
    const child = execute("gh", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
      if (code === 0 && !signal) resolve({
        output,
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
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

function runIdentity(run, repository) {
  return {
    repository: String(run.repository || run.repository_full_name || repository),
    runId: Number(run.database_id ?? run.run_id ?? run.id),
    runAttempt: Number(run.runAttempt ?? run.run_attempt ?? run.attempt) || 1,
  };
}

function runGhJobsApi(repository, runId, runAttempt, page, execute = spawn) {
  return new Promise((resolve, reject) => {
    const child = execute("gh", [
      "api", "--method", "GET",
      `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
      "-f", "per_page=100",
      "-f", `page=${page}`,
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
        resolve(Array.isArray(response.jobs) ? response.jobs : []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function reuseCachedJobs(runs, cachedRuns, repository) {
  const cachedByRun = new Map(cachedRuns.map((run) => {
    const identity = runIdentity(run, repository);
    return [`${identity.repository.toLowerCase()}:${identity.runId}`, { identity, run }];
  }));
  let reused = 0;
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const identity = runIdentity(run, repository);
    const cached = cachedByRun.get(`${identity.repository.toLowerCase()}:${identity.runId}`);
    if (
      !cached
      || cached.identity.runAttempt !== identity.runAttempt
      || cached.run.status !== "completed"
      || cached.run.jobs_complete !== true
      || !Array.isArray(cached.run.jobs)
    ) continue;
    run.jobs = cached.run.jobs.map(performanceJobRecord);
    run.jobs_collected = true;
    run.jobs_complete = true;
    reused += 1;
  }
  return reused;
}

async function collectJobDetails(runs, repository, execute) {
  const pending = runs.filter((run) => {
    const identity = runIdentity(run, repository);
    return Number.isSafeInteger(identity.runId)
      && identity.repository
      && (run.jobs_collected !== true || run.status !== "completed");
  });
  let nextRun = 0;
  let observed = 0;
  let failed = 0;
  let truncated = 0;
  const worker = async () => {
    while (nextRun < pending.length) {
      const run = pending[nextRun++];
      const identity = runIdentity(run, repository);
      try {
        const jobs = [];
        for (let page = 1; page <= ACTIONS_JOB_PAGE_LIMIT; page += 1) {
          const pageJobs = await runGhJobsApi(
            identity.repository,
            identity.runId,
            identity.runAttempt,
            page,
            execute,
          );
          jobs.push(...pageJobs);
          if (pageJobs.length < 100) break;
          if (page === ACTIONS_JOB_PAGE_LIMIT) truncated += 1;
        }
        run.jobs = jobs.map(performanceJobRecord);
        run.jobs_collected = true;
        run.jobs_complete = jobs.length < ACTIONS_JOB_PAGE_LIMIT * 100;
        observed += 1;
      } catch (error) {
        failed += 1;
        log.warning`Job metadata collection failed for run ${identity.runId}: ${error instanceof Error ? error.message : error}`;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(ACTIONS_API_CONCURRENCY, pending.length) },
    () => worker(),
  ));
  return {
    complete: failed === 0 && truncated === 0,
    requestedRuns: pending.length,
    observedRuns: observed,
    failedRuns: failed,
    truncatedRuns: truncated,
  };
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
    const { output: raw, stderr } = await runGhAw(targets, outputDirectory, logsPath, windowDays, runLimit, execute);
    if (stderr) log.info`${stderr}`;
    const snapshot = JSON.parse(raw);
    if (!Array.isArray(snapshot.runs)) throw new Error("gh aw logs returned invalid JSON");
    const reusedJobRuns = reuseCachedJobs(snapshot.runs, cachedRuns, repository);
    const jobDetails = await collectJobDetails(snapshot.runs, repository, execute);
    await writeFile(logsPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt,
      available: true,
      complete: jobDetails.complete,
      targetCount: targets.length,
      runCount: snapshot.runs.length,
      windowDays,
      runLimit,
      fallback: false,
      jobDetails: { ...jobDetails, reusedRuns: reusedJobRuns },
    }, null, 2)}\n`);
    const outcome = jobDetails.complete ? "success" : "partial";
    await writeOutcome(outcome);
    const workflowCount = new Set(snapshot.runs.map((run) => run.workflow_path || run.workflow_name || "unknown")).size;
    const runLabel = snapshot.runs.length === 1 ? "run" : "runs";
    const snapshotWorkflowLabel = workflowCount === 1 ? "workflow" : "workflows";
    log.info`Collected snapshot with ${snapshot.runs.length} ${runLabel} across ${workflowCount} ${snapshotWorkflowLabel}`;
    log.info`Collected job metadata for ${jobDetails.observedRuns} runs and reused ${reusedJobRuns} cached runs`;
    log.info`Downloaded ${snapshot.runs.length} ${runLabel} for ${targets.length} control-repository ${workflowLabel} with one gh aw logs invocation`;
    return outcome;
  } catch (error) {
    const enrichment = await enrichFromActions(
      targets,
      repository,
      windowDays,
      runLimit,
      cachedRuns,
      execute,
    );
    const enriched = enrichment.observedTargets > 0;
    const reusedJobRuns = reuseCachedJobs(enrichment.runs, cachedRuns, repository);
    const jobDetails = await collectJobDetails(enrichment.runs, repository, execute);
    const mergedSnapshot = { ...cachedSnapshot, runs: enrichment.runs };
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
      jobDetails: { ...jobDetails, reusedRuns: reusedJobRuns },
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
