import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
const directory = "docs/operational-value/proof/checkout-pr-dispatch";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;

export async function collectCheckoutEvidence(cache) {
  const contract = readCensusJson(`${directory}/contract.json`);
  const acquiredAt = new Date().toISOString(), endpointReceipts = [];
  mkdirSync(cache, { recursive: true });
  async function request(endpoint, binary = false) {
    const file = path.join(cache, hash(endpoint) + (binary ? ".zip" : ".json"));
    const errorFile = `${file}.unavailable.json`;
    if (existsSync(errorFile)) return JSON.parse(readFileSync(errorFile, "utf8"));
    let bytes;
    if (existsSync(file)) bytes = readFileSync(file);
    else {
      try {
        const result = await execute("gh", ["api", endpoint], {
          encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 60000,
          env: { ...process.env, GH_PAGER: "cat" },
        });
        bytes = result.stdout;
        writeFileSync(file, bytes);
      } catch (error) {
        const status = String(error.stderr).match(/HTTP (403|404|410)/)?.[1];
        if (!status) throw new Error(`Checkout acquisition failed: ${error.code ?? error.status ?? "unknown"} ${endpoint}`);
        const unavailable = { unavailable: true, status: Number(status), endpoint, observedAt: acquiredAt };
        writeFileSync(errorFile, JSON.stringify(unavailable));
        return unavailable;
      }
    }
    endpointReceipts.push({ endpoint, sha256: hash(bytes), bytes: bytes.length });
    return binary ? { bytes, file } : JSON.parse(bytes);
  }
  const repository = await request("repos/github/gh-aw");
  if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository) throw new Error("Repository scope mismatch");
  const inventory = new Map(), pages = [];
  let expected;
  for (let page = 1; ; page++) {
    const range = encodeURIComponent(`${contract.adoption.adoptedAt}..${contract.until}`);
    const endpoint = `repos/github/gh-aw/actions/workflows/${contract.workflowId}.lock.yml/runs?created=${range}&per_page=100&page=${page}`;
    const response = await request(endpoint);
    if (response.unavailable || !Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count)
      || response.total_count > 1000 || expected !== undefined && expected !== response.total_count) throw new Error("Incomplete/unstable Actions inventory");
    expected = response.total_count;
    pages.push({ endpoint, total: expected, count: response.workflow_runs.length, responseSha256: censusDigest(response) });
    for (const run of response.workflow_runs) {
      if (!positive(run.id) || inventory.has(run.id) || run.repository?.id !== contract.repositoryId
        || run.path.split("@")[0] !== `.github/workflows/${contract.workflowId}.lock.yml`) throw new Error("Invalid/duplicate checkout run identity");
      inventory.set(run.id, run);
    }
    if (inventory.size === expected) break;
    if (!response.workflow_runs.length || inventory.size > expected || page >= 10) throw new Error("Actions pagination incomplete");
  }
  const runs = [...inventory.values()].filter(run => run.created_at < contract.until);
  const observations = [];
  let next = 0;
  async function inspect() {
    while (next < runs.length) {
      const run = runs[next++], jobPages = [], jobs = [];
      let jobTotal;
      for (let page = 1; ; page++) {
        const endpoint = `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=${page}`;
        const response = await request(endpoint);
        if (response.unavailable) { jobPages.push(response); break; }
        if (!Array.isArray(response.jobs) || !Number.isSafeInteger(response.total_count)
          || jobTotal !== undefined && jobTotal !== response.total_count) throw new Error("Invalid checkout job inventory");
        jobTotal = response.total_count;
        jobs.push(...response.jobs.map(job => ({ id: job.id, runId: job.run_id, name: job.name,
          status: job.status, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
          steps: job.steps ?? [] })));
        jobPages.push({ endpoint, count: response.jobs.length, total: jobTotal, responseSha256: censusDigest(response) });
        if (jobs.length === jobTotal) break;
        if (!response.jobs.length || jobs.length > jobTotal) throw new Error("Checkout job pages incomplete");
      }
      const checkoutSteps = jobs.flatMap(job => job.steps.filter(step => step.name === "Checkout PR branch")
        .map(step => ({ jobId: job.id, jobName: job.name, step })));
      const artifacts = [];
      for (let page = 1; ; page++) {
        const endpoint = `repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`;
        const response = await request(endpoint);
        if (response.unavailable) { artifacts.push(response); break; }
        if (!Array.isArray(response.artifacts) || !Number.isSafeInteger(response.total_count)) throw new Error("Invalid checkout artifact inventory");
        artifacts.push(...response.artifacts.map(row => ({ id: row.id, name: row.name, expired: row.expired,
          size: row.size_in_bytes, digest: row.digest ?? null, createdAt: row.created_at,
          runId: row.workflow_run?.id ?? null, headSha: row.workflow_run?.head_sha ?? null })));
        if (artifacts.length === response.total_count) break;
        if (!response.artifacts.length || artifacts.length > response.total_count) throw new Error("Incomplete checkout artifact pages");
      }
      let log = { status: "not-produced", reason: "No initial-attempt protected checkout step ran." };
      if (checkoutSteps.some(row => row.step.conclusion !== "skipped")) {
        const endpoint = `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/logs`;
        const response = await request(endpoint, true);
        if (response.unavailable) log = { status: "unavailable", ...response };
        else {
          const listing = execFileSync("unzip", ["-Z1", response.file], { encoding: "utf8", maxBuffer: 1024 * 1024 });
          const entries = listing.trim().split("\n").filter(name =>
            /^(?:[^/]+\/)?\d+_Checkout PR branch\.txt$/.test(name) && !name.split("/").includes(".."));
          const projections = [];
          for (const name of entries) {
            const bytes = execFileSync("unzip", ["-p", response.file, name], { maxBuffer: 2 * 1024 * 1024 });
            const lines = bytes.toString().split(/\r?\n/).filter(line =>
              /^\d{4}-\d\d-\d\dT[^ ]+ (?:Event(?: type)?: |PR number: |Head ref: |Head SHA: |Head repo: |Base repo: |Current repository: |GitHub SHA: |Pull Request #|No pull request context available|Recorded PR head baseline for incremental patches: |Current branch: |Detected (?:workflow_dispatch|issue_comment)|Checking out branch: |Runtime safety check passed|##\[command\].*git (?:fetch|checkout|rev-parse))/.test(line));
            projections.push({ entry: name, sha256: hash(bytes), lines });
          }
          log = { status: projections.length ? "protected-projection" : "no-separated-checkout-log",
            archiveSha256: hash(response.bytes), entryCount: entries.length, projections };
        }
      }
      const reasons = ["No preserved original complete event payload and fetch-time expected PR-head receipt.",
        "No protected pre-agent clean/initialized/origin/history conjunction exists in the reviewed checkout instrument."];
      observations.push({ runId: run.id, attempt: 1, createdAt: run.created_at, event: run.event,
        runStatus: run.status, runConclusion: run.conclusion,
        headSha: run.head_sha, headRepositoryId: run.head_repository?.id ?? null, workflowId: run.workflow_id,
        latestAttemptAtAcquisition: run.run_attempt, associatedPullRequests: (run.pull_requests ?? []).map(pr => ({
          number: pr.number, id: pr.id, headSha: pr.head?.sha, headRef: pr.head?.ref,
          headRepositoryId: pr.head?.repo?.id ?? null,
        })),
        jobPages, jobs, checkoutSteps, artifacts, log, receipt: null, missingReasons: reasons });
    }
  }
  await Promise.all(Array.from({ length: 6 }, inspect));
  observations.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId - b.runId);
  writeCensusJson(`${directory}/observations.json.gz`, observations);
  const events = {}, steps = {}, logs = {};
  for (const row of observations) {
    events[row.event] = (events[row.event] ?? 0) + 1;
    logs[row.log.status] = (logs[row.log.status] ?? 0) + 1;
    for (const step of row.checkoutSteps) steps[step.step.conclusion] = (steps[step.step.conclusion] ?? 0) + 1;
  }
  const index = { schemaVersion: 1, workflowId: contract.workflowId, repository: contract.repository,
    repositoryId: contract.repositoryId, until: contract.until, acquiredAt,
    inventoryComplete: inventory.size === expected, inventoryRuns: observations.length, pages,
    contractSha256: censusDigest(contract), observationsSha256: censusDigest(observations),
    events, checkoutSteps: steps, logs, independentCheckoutProofs: 0, independentHeadProofs: 0,
    measurementReady: false, classification: "blocked-independent-checkout-receipts",
    originalEvents: 0, eligibilityKnown: observations.filter(row => row.event === "schedule").length,
    attempts: "All initial attempts; reruns retained as metadata, never multiplied into opportunities.",
    acquisition: { endpointReceipts, producer: "scripts/collect-checkout-pr-evidence.mjs",
      producerSha256: hash(readFileSync(import.meta.filename)) },
    openRequirements: ["Original event/dispatch inputs joined to actual source policy at execution.",
      "Contemporaneous expected PR head/ref and protected actual pre-agent checkout state including cleanliness.",
      "An independently complete opportunity denominator across dispatch, centralized slash and direct PR/comment trigger classes."],
  };
  writeCensusJson(`${directory}/index.json`, index);
  console.log(JSON.stringify({ runs: observations.length, events, steps, logs, measurementReady: false }));
  return index;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3) throw new Error("usage: collect-checkout-pr-evidence.mjs PRIVATE_API_CACHE");
  await collectCheckoutEvidence(process.argv[2]);
}
