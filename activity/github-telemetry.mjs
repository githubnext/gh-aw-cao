#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "./actions-log.mjs";

const DEFAULT_CACHE_ROOT = path.join(process.env.RUNNER_TEMP || "/tmp", "cao-activity");
const DEFAULT_LEDGER_PATH = path.join(process.env.RUNNER_TEMP || "/tmp", "cao-gh", "cao-gh.jsonl");
export const GITHUB_TELEMETRY_RETENTION_HOURS = 24;
export const GITHUB_TELEMETRY_STACK_TRACE_LIMIT = 24;
const EMPTY_RATE_LIMIT_ERROR = "GitHub API returned no valid rate-limit resources.";

// Keep telemetry storage in the original capture order; tree-table rendering flips it to caller-first.
export function normalizeGithubTelemetryStackTrace(stackTrace, limit = GITHUB_TELEMETRY_STACK_TRACE_LIMIT) {
  const frames = Array.isArray(stackTrace)
    ? stackTrace
    : typeof stackTrace === "string"
      ? stackTrace.split(/\r?\n/).slice(stackTrace.startsWith("Error") ? 1 : 0)
      : [];
  return frames
    .map((frame) => String(frame ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function defaultGithubTelemetryStackTrace(limit = GITHUB_TELEMETRY_STACK_TRACE_LIMIT) {
  const stack = new Error().stack;
  if (typeof stack !== "string") return [];
  return normalizeGithubTelemetryStackTrace(stack.split(/\r?\n/).slice(2), limit);
}

export async function collectActivityCacheState(root = DEFAULT_CACHE_ROOT, execute = spawnSync) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const size = entries.length > 0
    ? execute("du", ["-sk", "--", root], { encoding: "utf8", maxBuffer: 1024 * 1024 })
    : { status: 0, stdout: "0" };
  const kibibytes = size.status === 0 ? Number.parseInt(size.stdout, 10) : 0;
  return {
    hydrated: entries.some((entry) => entry.isFile()),
    bytes: Number.isSafeInteger(kibibytes) ? kibibytes * 1024 : 0,
    entryCount: entries.length,
    folderCount: entries.filter((entry) => entry.isDirectory()).length,
  };
}

export function normalizeRateLimit(document) {
  const resources = {};
  for (const [name, value] of Object.entries(document?.resources || {})) {
    if (![value?.limit, value?.remaining, value?.reset].every(Number.isSafeInteger)) continue;
    resources[name] = {
      limit: value.limit,
      used: Number.isSafeInteger(value.used) ? value.used : Math.max(0, value.limit - value.remaining),
      remaining: value.remaining,
      resetAt: new Date(value.reset * 1000).toISOString(),
    };
  }
  return resources;
}

function queryRateLimit(token, execute = spawnSync) {
  const result = execute("gh", ["api", "rate_limit"], {
    encoding: "utf8",
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `gh api rate_limit exited with status ${result.status}`);
  const rateLimit = normalizeRateLimit(JSON.parse(result.stdout));
  if (Object.keys(rateLimit).length === 0) throw new Error(EMPTY_RATE_LIMIT_ERROR);
  return rateLimit;
}

export async function prepareGithubTelemetryHistory({
  sourcePath,
  ledgerPath = DEFAULT_LEDGER_PATH,
  now = () => new Date(),
  retentionHours = GITHUB_TELEMETRY_RETENTION_HOURS,
}) {
  const content = sourcePath
    ? await readFile(sourcePath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    })
    : "";
  const nowMs = now().getTime();
  const cutoff = nowMs - retentionHours * 60 * 60 * 1000;
  const retained = content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      const observedAt = Date.parse(entry?.observedAt);
      return entry?.schemaVersion === 1 && Number.isFinite(observedAt) && observedAt >= cutoff && observedAt <= nowMs ? [entry] : [];
    } catch {
      return [];
    }
  });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, retained.map((entry) => JSON.stringify(entry)).join("\n") + (retained.length > 0 ? "\n" : ""), { mode: 0o600 });
  return retained.length;
}

export async function recordGithubTelemetry({
  phase,
  operation,
  outcome = "unknown",
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
  tokenType = process.env.CAO_GITHUB_TOKEN_TYPE || "unknown",
  cacheRoot = process.env.CAO_ACTIVITY_CACHE_ROOT || DEFAULT_CACHE_ROOT,
  ledgerPath = process.env.CAO_GH_LEDGER || DEFAULT_LEDGER_PATH,
  execute = spawnSync,
  now = () => new Date(),
  stackTrace = defaultGithubTelemetryStackTrace(),
}) {
  const normalizedStackTrace = normalizeGithubTelemetryStackTrace(stackTrace);
  let rateLimit = {};
  let rateLimitError = null;
  try {
    rateLimit = queryRateLimit(token, execute);
  } catch (error) {
    rateLimitError = error instanceof Error ? error.message : String(error);
  }
  const entry = {
    schemaVersion: 1,
    observedAt: now().toISOString(),
    pairId: [
      process.env.GITHUB_RUN_ID || "local",
      process.env.GITHUB_RUN_ATTEMPT || "1",
      process.env.GITHUB_JOB || "unknown",
      operation,
    ].join(":"),
    phase,
    operation,
    outcome,
    tokenType,
    credentialId: process.env.CAO_GITHUB_CREDENTIAL_ID || null,
    credentialRole: process.env.CAO_GITHUB_CREDENTIAL_ROLE || "read",
    repository: process.env.GITHUB_REPOSITORY || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    job: process.env.GITHUB_JOB || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    stackTrace: normalizedStackTrace,
    rateLimit,
    rateLimitError,
    activityCache: await collectActivityCacheState(cacheRoot),
  };
  entry.activityCache.key = process.env.CAO_ACTIVITY_CACHE_KEY || null;
  entry.activityCache.matchedKey = process.env.CAO_ACTIVITY_CACHE_MATCHED_KEY || null;
  entry.activityCache.hit = Boolean(entry.activityCache.matchedKey);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (entry.rateLimit.core) {
    log.info`GitHub API core remaining (${phase} ${operation}): ${entry.rateLimit.core.remaining}/${entry.rateLimit.core.limit}`;
  } else {
    log.warning`GitHub API core rate limit unavailable (${phase} ${operation}): ${entry.rateLimitError}`;
  }
  log.info`Activity cache ${phase} ${operation}: ${entry.activityCache.hit ? "matched" : "missed"} key=${entry.activityCache.key || "unknown"} matched=${entry.activityCache.matchedKey || "none"} entries=${entry.activityCache.entryCount} folders=${entry.activityCache.folderCount} bytes=${entry.activityCache.bytes}`;
  return entry;
}

async function main() {
  const [phase, operation] = process.argv.slice(2);
  if (phase === "prepare") {
    await prepareGithubTelemetryHistory({ sourcePath: operation });
    return;
  }
  if (!["before", "after"].includes(phase) || !operation) {
    throw new Error("usage: github-telemetry.mjs prepare [prior-ledger] | <before|after> <operation>");
  }
  await recordGithubTelemetry({
    phase,
    operation,
    outcome: process.env.CAO_OPERATION_OUTCOME || "unknown",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
