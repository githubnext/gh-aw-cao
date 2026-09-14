#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API_VERSION = "2022-11-28";

function parseArguments(argv) {
  const options = {
    repo: "githubnext/gh-aw-cao",
    workflow: "cao-activity.yml",
    runs: 4,
    output: "activity-api-cost-data",
    shardCount: 1,
    shardIndex: 0,
    concurrency: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--repo") options.repo = value;
    else if (name === "--workflow") options.workflow = value;
    else if (name === "--runs") options.runs = Number(value);
    else if (name === "--output") options.output = value;
    else if (name === "--shard-count") options.shardCount = Number(value);
    else if (name === "--shard-index") options.shardIndex = Number(value);
    else if (name === "--concurrency") options.concurrency = Number(value);
    else if (name === "--help") {
      console.log("Usage: download-runs.mjs [--repo OWNER/REPO] [--workflow FILE] [--runs N] [--output DIR] [--shard-count N] [--shard-index N] [--concurrency N]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${name}`);
    }
    index += 1;
  }
  for (const [name, value] of [
    ["runs", options.runs],
    ["shard-count", options.shardCount],
    ["concurrency", options.concurrency],
  ]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  }
  if (!Number.isInteger(options.shardIndex) || options.shardIndex < 0 || options.shardIndex >= options.shardCount) {
    throw new Error("--shard-index must be an integer between zero and shard-count minus one");
  }
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) throw new Error("--repo must use OWNER/REPO syntax");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN to a token with Actions read access");

const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const [owner, repository] = options.repo.split("/");
const requestLedger = [];

function recordRequest(url, response, category) {
  const parsed = new URL(url);
  requestLedger.push({
    category,
    method: "GET",
    path: parsed.pathname,
    status: response.status,
    primaryUnits: parsed.origin === new URL(apiBase).origin && parsed.pathname !== "/rate_limit" ? 1 : 0,
    rateLimit: {
      resource: response.headers.get("x-ratelimit-resource"),
      limit: Number(response.headers.get("x-ratelimit-limit")) || null,
      remaining: Number(response.headers.get("x-ratelimit-remaining")) || null,
      used: Number(response.headers.get("x-ratelimit-used")) || null,
      reset: Number(response.headers.get("x-ratelimit-reset")) || null,
    },
  });
}

async function githubFetch(url, category, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: ["Bearer", token].join(" "),
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "gh-aw-cao-activity-api-cost",
      ...init.headers,
    },
  });
  recordRequest(url, response, category);
  if (!response.ok && response.status !== 302) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}: ${body.slice(0, 200)}`);
  }
  return response;
}

async function listPages(url, field, category) {
  const values = [];
  let next = url;
  while (next) {
    const response = await githubFetch(next, category);
    const body = await response.json();
    values.push(...(body[field] || []));
    const match = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    next = match?.[1] || "";
  }
  return values;
}

async function downloadRedirect(url, destination, category) {
  const response = await githubFetch(url, category, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`GitHub API did not return a download redirect for ${new URL(url).pathname}`);
  const download = await fetch(location, { redirect: "follow" });
  if (!download.ok || !download.body) throw new Error(`Artifact storage returned HTTP ${download.status}`);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(destination));
  return Number(download.headers.get("content-length")) || null;
}

async function downloadRun(run) {
  const runDirectory = path.resolve(options.output, `shard-${options.shardIndex}-of-${options.shardCount}`, String(run.id));
  await mkdir(runDirectory, { recursive: true });
  const artifacts = await listPages(
    `${apiBase}/repos/${owner}/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    "artifacts",
    "artifact-list",
  );
  const artifact = artifacts.find((candidate) => candidate.name === "cao-activity-index" && !candidate.expired);
  if (!artifact) throw new Error(`Run ${run.id} has no unexpired cao-activity-index artifact`);
  const artifactBytes = await downloadRedirect(
    `${apiBase}/repos/${owner}/${repository}/actions/artifacts/${artifact.id}/zip`,
    path.join(runDirectory, "cao-activity-index.zip"),
    "artifact-download",
  );
  const logBytes = await downloadRedirect(
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

const workflowRuns = await listPages(
  `${apiBase}/repos/${owner}/${repository}/actions/workflows/${encodeURIComponent(options.workflow)}/runs?status=completed&per_page=100`,
  "workflow_runs",
  "run-list",
);
const selected = workflowRuns
  .filter((run) => run.conclusion === "success")
  .slice(0, options.runs)
  .filter((_, index) => index % options.shardCount === options.shardIndex);
const downloaded = await mapConcurrent(selected, options.concurrency, downloadRun);
const manifest = {
  generatedAt: new Date().toISOString(),
  repository: options.repo,
  workflow: options.workflow,
  requestedSuccessfulRuns: options.runs,
  shard: { count: options.shardCount, index: options.shardIndex },
  downloaded,
  api: {
    primaryUnits: requestLedger.reduce((sum, request) => sum + request.primaryUnits, 0),
    requests: requestLedger,
  },
};
await mkdir(path.resolve(options.output), { recursive: true });
await writeFile(
  path.resolve(options.output, `download-manifest-${options.shardIndex}-of-${options.shardCount}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify({
  downloadedRuns: downloaded.length,
  primaryUnits: manifest.api.primaryUnits,
  output: path.resolve(options.output),
}));
