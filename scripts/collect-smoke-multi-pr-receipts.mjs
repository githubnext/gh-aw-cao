import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { multiPrScope } from "./collect-smoke-multi-pr-value.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
export function multiPrHttpResponse(value) {
  let body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const responses = [];
  while (/^HTTP\/[\d.]+ \d{3}\b/.test(body.subarray(0, 32).toString())) {
    const crlf = body.indexOf("\r\n\r\n"), lf = body.indexOf("\n\n");
    const separator = crlf >= 0 && (lf < 0 || crlf < lf) ? Buffer.from("\r\n\r\n") : Buffer.from("\n\n");
    const end = body.indexOf(separator);
    if (end < 0 || end > 32768 || responses.length >= 4) throw new Error("Malformed native GitHub response headers");
    const lines = body.subarray(0, end).toString("utf8").split(/\r?\n/);
    const headers = Object.fromEntries(lines.slice(1).flatMap(line => {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      return match && ["date", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "x-github-request-id"]
        .includes(match[1].toLowerCase()) ? [[match[1].toLowerCase(), match[2]]] : [];
    }));
    responses.push({ status: Number(lines[0].match(/^HTTP\/[\d.]+ (\d{3})\b/)[1]), headers });
    body = body.subarray(end + separator.length);
  }
  if (!responses.length) throw new Error("Missing native GitHub response headers");
  return { body, responses };
}
function retainedMultiPrPause(cache) {
  const file = path.join(cache, "api-pause.json");
  if (!existsSync(file)) return null;
  const pause = JSON.parse(readFileSync(file, "utf8"));
  const until = Date.parse(pause?.retryNotBefore);
  if (typeof pause?.retryNotBefore !== "string" || !Number.isFinite(until)
    || new Date(until).toISOString() !== pause.retryNotBefore) {
    throw new Error("Invalid persisted GitHub quota pause; acquisition remains blocked.");
  }
  return pause;
}
export function multiPrAcquisitionStop(response) {
  return [403, 429].includes(response.status) || response.headers["x-ratelimit-remaining"] === "0"
    || Object.hasOwn(response.headers, "retry-after");
}
export function retainMultiPrHttp(cache, endpoint, bytes) {
  const response = multiPrHttpResponse(bytes);
  const receipt = { endpoint, observedAt: new Date().toISOString(), responses: response.responses };
  writeFileSync(path.join(cache, `${hash(endpoint)}.http.json`), JSON.stringify(receipt));
  const blocked = response.responses.filter(multiPrAcquisitionStop);
  if (blocked.length) {
    const directory = path.join(cache, "quota-receipts");
    mkdirSync(directory, { recursive: true });
    const original = JSON.stringify(receipt);
    writeFileSync(path.join(directory, `${hash(original)}.json`), original);
  }
  let previous = retainedMultiPrPause(cache);
  for (const item of blocked) {
    const reset = item.headers["x-ratelimit-remaining"] === "0" ? Number(item.headers["x-ratelimit-reset"]) * 1000 : 0;
    const retry = item.headers["retry-after"];
    const after = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
    const until = Math.max(Number.isFinite(reset) ? reset : 0, Number.isFinite(after) ? after : 0);
    if (until > Date.now() && (!previous || until + 1000 > Date.parse(previous.retryNotBefore))) {
      previous = { endpoint, observedAt: receipt.observedAt, retryNotBefore: new Date(until + 1000).toISOString(), response: item };
      writeFileSync(path.join(cache, "api-pause.json"), JSON.stringify(previous));
    }
  }
  return response.body;
}
export function assertMultiPrQuotaReady(cache) {
  const pause = retainedMultiPrPause(cache);
  if (!pause) return;
  if (Date.parse(pause.retryNotBefore) > Date.now()) {
    const error = new Error(`Acquisition open: honor retained GitHub quota/Retry-After until ${pause.retryNotBefore}.`);
    error.acquisitionPause = true;
    throw error;
  }
}
export async function multiPrRequest(cache, endpoint) {
  if (!endpoint.startsWith("repos/github/gh-aw/")) throw new Error("Unapproved evidence repository");
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, `${hash(endpoint)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  assertMultiPrQuotaReady(cache);
  try {
    await setTimeout(500);
    const { stdout } = await execute("gh", ["api", "--include", endpoint], { timeout: 60000, maxBuffer: 24 * 1024 * 1024 });
    const value = JSON.parse(retainMultiPrHttp(cache, endpoint, stdout));
    writeFileSync(file, JSON.stringify(value));
    return value;
  } catch (error) {
    if (/^HTTP\/[\d.]+ \d{3}\b/.test(String(error.stdout).slice(0, 32))) retainMultiPrHttp(cache, endpoint, error.stdout);
    if (/HTTP (404|410)/.test(String(error.stderr))) {
      const value = { unavailable: true, status: Number(String(error.stderr).match(/HTTP (404|410)/)[1]),
        endpoint, observedAt: new Date().toISOString() };
      writeFileSync(file, JSON.stringify(value));
      return value;
    }
    throw error;
  }
}

export async function multiPrMap(rows, work, concurrency = 6) {
  const results = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      results[index] = await work(rows[index], index);
    }
  }));
  return results;
}

export async function collectMultiPrReceipts(cache) {
  const directory = multiPrScope.directory;
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  if (!inventory.complete || inventory.sourceGitBlob !== multiPrScope.sourceGitBlob) throw new Error("Incomplete initial inventory");
  let done = 0;
  const rows = await multiPrMap(inventory.runs, async run => {
    const projected = path.join(cache, `run-${run.id}-initial.json`);
    if (existsSync(projected)) {
      const retained = JSON.parse(readFileSync(projected, "utf8"));
      if (retained.scopeVersion === 2) return retained;
    }
    const jobs = [];
    let unavailable = null, total;
    for (let page = 1; ; page++) {
      const result = await multiPrRequest(cache, `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=${page}`);
      if (result.unavailable) { unavailable = result; break; }
      total ??= result.total_count;
      if (!Number.isSafeInteger(total) || result.total_count !== total || !Array.isArray(result.jobs)) throw new Error("Invalid jobs inventory");
      jobs.push(...result.jobs);
      if (jobs.length === total) break;
      if (!result.jobs.length || jobs.length > total || page > 10) throw new Error("Incomplete jobs inventory");
    }
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error("Duplicate protected job");
    const safeJobs = jobs.filter(job => job.steps?.length && (/^safe[_ ]outputs$/i.test(job.name)
      || job.steps.some(step => /create.*pull.*request|process.*safe.*output/i.test(step.name))));
    const result = { scopeVersion: 2, runId: run.id, attempt: 1, at: run.at, jobsUnavailable: unavailable,
      jobsComplete: !unavailable, jobsCount: total ?? null, jobsResponseSha256: censusDigest(jobs),
      reruns: Array.from({ length: run.attemptCount - 1 }, (_, i) => ({ attempt: i + 2, eligibility: "excluded-rerun-no-duplicate-credit" })),
      safeJobs: safeJobs.map(job => ({ id: job.id, name: job.name, runId: job.run_id, attempt: job.run_attempt,
        headSha: job.head_sha, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
        steps: job.steps })),
      allJobNames: jobs.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion })),
      artifactInventory: null };
    if (safeJobs.length || inventory.candidates.some(candidate => Number(candidate.workflowReference?.runId) === run.id)) {
      const artifacts = [];
      for (let page = 1; ; page++) {
        const response = await multiPrRequest(cache, `repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
        if (response.unavailable) { result.artifactInventory = response; break; }
        if (!Array.isArray(response.artifacts) || !Number.isSafeInteger(response.total_count)) throw new Error("Invalid artifacts inventory");
        artifacts.push(...response.artifacts);
        if (artifacts.length === response.total_count) {
          result.artifactInventory = { complete: true, responseSha256: censusDigest(artifacts),
            artifacts: artifacts.map(item => ({ id: item.id, name: item.name, expired: item.expired, size: item.size_in_bytes,
              createdAt: item.created_at, digest: item.digest, runId: item.workflow_run?.id, headSha: item.workflow_run?.head_sha })) };
          break;
        }
        if (!response.artifacts.length || page > 10) throw new Error("Incomplete artifacts inventory");
      }
    }
    writeFileSync(projected, JSON.stringify(result));
    if (++done % 100 === 0) console.error(`Inventoried ${done} initial job histories.`);
    return result;
  });
  const candidateRunIds = [...new Set(inventory.candidates.map(row => Number(row.workflowReference?.runId)).filter(Number.isSafeInteger))];
  const extra = await multiPrMap(candidateRunIds.filter(id => !inventory.runs.some(run => run.id === id)), async id => {
    const response = await multiPrRequest(cache, `repos/github/gh-aw/actions/runs/${id}`);
    return response.unavailable ? { id, ...response } : { id, path: response.path, at: response.created_at,
      reason: "Candidate references a run outside the retained workflow inventory; never inferred absent success." };
  });
  const result = { complete: true, inventorySha256: censusDigest(inventory), rows, missingCandidateRuns: extra,
    observedAt: new Date().toISOString(), factsSha256: censusDigest(rows) };
  writeCensusJson(`${directory}/receipts.json.gz`, result);
  console.log(JSON.stringify({ initialRuns: rows.length, jobsAvailable: rows.filter(row => row.jobsComplete).length,
    safeJobRuns: rows.filter(row => row.safeJobs.length).length, missingCandidateRuns: extra.length }));
  return result;
}

export function multiPrZipEntries(cache, bytes, match) {
  const file = path.join(cache, `archive-${hash(bytes)}.zip`);
  writeFileSync(file, bytes);
  const entries = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 })
    .trim().split("\n");
  if (entries.length > 5000 || new Set(entries).size !== entries.length
    || entries.some(entry => entry.startsWith("/") || entry.split("/").includes("..") || /[\0\r]/.test(entry))) {
    throw new Error("Unsafe or duplicated ZIP entries");
  }
  return entries.filter(match).map(entry => ({ entry, bytes: execFileSync("unzip", ["-p", file, entry], {
    timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await collectMultiPrReceipts(process.argv[2] ?? ".cache/smoke-multi-pr");
}
