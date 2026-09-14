import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API_VERSION = "2022-11-28";

function normalizeOptions(options) {
  const normalized = {
    repo: options.repo || "githubnext/gh-aw-cao",
    workflow: options.workflow || "cao-activity.yml",
    runs: Number(options.runs ?? 4),
    output: options.output || "activity-api-cost-data",
    shardCount: Number(options["shard-count"] ?? 1),
    shardIndex: Number(options["shard-index"] ?? 0),
    concurrency: Number(options.concurrency ?? 2),
    before: options.before || "",
  };
  for (const [name, value] of [
    ["runs", normalized.runs],
    ["shard-count", normalized.shardCount],
    ["concurrency", normalized.concurrency],
  ]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  }
  if (!Number.isInteger(normalized.shardIndex) || normalized.shardIndex < 0 || normalized.shardIndex >= normalized.shardCount) {
    throw new Error("--shard-index must be an integer between zero and shard-count minus one");
  }
  if (!/^[^/]+\/[^/]+$/.test(normalized.repo)) throw new Error("--repo must use OWNER/REPO syntax");
  if (normalized.before && Number.isNaN(Date.parse(normalized.before))) throw new Error("--before must be an ISO timestamp");
  return normalized;
}

function recordRequest(ledger, apiBase, url, response, category) {
  const parsed = new URL(url);
  const headerNumber = (name) => {
    const value = response.headers.get(name);
    return value == null || value === "" ? null : Number(value);
  };
  ledger.push({
    category,
    method: "GET",
    path: parsed.pathname,
    status: response.status,
    primaryUnits: parsed.origin === new URL(apiBase).origin && parsed.pathname !== "/rate_limit" ? 1 : 0,
    rateLimit: {
      resource: response.headers.get("x-ratelimit-resource"),
      limit: headerNumber("x-ratelimit-limit"),
      remaining: headerNumber("x-ratelimit-remaining"),
      used: headerNumber("x-ratelimit-used"),
      reset: headerNumber("x-ratelimit-reset"),
    },
  });
}

async function githubFetch(fetchImplementation, token, ledger, apiBase, url, category, init = {}) {
  const response = await fetchImplementation(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: ["Bearer", token].join(" "),
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "gh-aw-cao-activity-api-cost",
      ...init.headers,
    },
  });
  recordRequest(ledger, apiBase, url, response, category);
  if (!response.ok && response.status !== 302) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}: ${body.slice(0, 200)}`);
  }
  return response;
}

async function listPages(request, url, field, category) {
  const values = [];
  let next = url;
  while (next) {
    const response = await request(next, category);
    const body = await response.json();
    values.push(...(body[field] || []));
    const match = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    next = match?.[1] || "";
  }
  return values;
}

async function listLatestSuccessfulRuns(request, url, count) {
  const values = [];
  let next = url;
  while (next && values.length < count) {
    const response = await request(next, "run-list");
    const body = await response.json();
    values.push(...(body.workflow_runs || []).filter((run) => run.conclusion === "success"));
    const match = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    next = match?.[1] || "";
  }
  return values.slice(0, count);
}

async function downloadRedirect(request, fetchImplementation, url, destination, category) {
  const response = await request(url, category, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`GitHub API did not return a download redirect for ${new URL(url).pathname}`);
  const download = await fetchImplementation(location, { redirect: "follow" });
  if (!download.ok || !download.body) throw new Error(`Artifact storage returned HTTP ${download.status}`);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(destination));
  return Number(download.headers.get("content-length")) || null;
}

async function downloadRun(run, context) {
  const { apiBase, fetchImplementation, options, owner, repository, request } = context;
  const runDirectory = path.resolve(options.output, `shard-${options.shardIndex}-of-${options.shardCount}`, String(run.id));
  await mkdir(runDirectory, { recursive: true });
  const artifacts = await listPages(
    request,
    `${apiBase}/repos/${owner}/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    "artifacts",
    "artifact-list",
  );
  const artifact = artifacts.find((candidate) => candidate.name === "cao-activity-index" && !candidate.expired);
  if (!artifact) throw new Error(`Run ${run.id} has no unexpired cao-activity-index artifact`);
  const artifactBytes = await downloadRedirect(
    request,
    fetchImplementation,
    `${apiBase}/repos/${owner}/${repository}/actions/artifacts/${artifact.id}/zip`,
    path.join(runDirectory, "cao-activity-index.zip"),
    "artifact-download",
  );
  const logBytes = await downloadRedirect(
    request,
    fetchImplementation,
    `${apiBase}/repos/${owner}/${repository}/actions/runs/${run.id}/logs`,
    path.join(runDirectory, "job-logs.zip"),
    "log-download",
  );
  await writeFile(
    path.join(runDirectory, "run.json"),
    `${JSON.stringify({ run, artifact, downloadedBytes: { artifact: artifactBytes, logs: logBytes } }, null, 2)}\n`,
  );
  return { id: run.id, runNumber: run.run_number, artifactId: artifact.id, artifactBytes, logBytes };
}

async function mapConcurrent(values, concurrency, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function downloadWorkflowRuns(rawOptions = {}, {
  fetchImplementation = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
} = {}) {
  const options = normalizeOptions(rawOptions);
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN to a token with Actions read access");
  const apiBase = apiUrl.replace(/\/$/, "");
  const [owner, repository] = options.repo.split("/");
  const requestLedger = [];
  const request = (url, category, init) => (
    githubFetch(fetchImplementation, token, requestLedger, apiBase, url, category, init)
  );
  const workflowRunsUrl = new URL(
    `${apiBase}/repos/${owner}/${repository}/actions/workflows/${encodeURIComponent(options.workflow)}/runs`,
  );
  workflowRunsUrl.searchParams.set("status", "completed");
  workflowRunsUrl.searchParams.set("per_page", "100");
  if (options.before) workflowRunsUrl.searchParams.set("created", `<=${new Date(options.before).toISOString()}`);
  const workflowRuns = await listLatestSuccessfulRuns(request, workflowRunsUrl.toString(), options.runs);
  const selected = workflowRuns
    .filter((_, index) => index % options.shardCount === options.shardIndex);
  const context = { apiBase, fetchImplementation, options, owner, repository, request };
  const downloaded = await mapConcurrent(selected, options.concurrency, (run) => downloadRun(run, context));
  const manifest = {
    generatedAt: new Date().toISOString(),
    repository: options.repo,
    workflow: options.workflow,
    before: options.before || null,
    requestedSuccessfulRuns: options.runs,
    shard: { count: options.shardCount, index: options.shardIndex },
    downloaded,
    api: {
      primaryUnits: requestLedger.reduce((sum, requestEntry) => sum + requestEntry.primaryUnits, 0),
      requests: requestLedger,
    },
  };
  await mkdir(path.resolve(options.output), { recursive: true });
  await writeFile(
    path.resolve(options.output, `download-manifest-${options.shardIndex}-of-${options.shardCount}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    downloadedRuns: downloaded.length,
    primaryUnits: manifest.api.primaryUnits,
    output: path.resolve(options.output),
  };
}
