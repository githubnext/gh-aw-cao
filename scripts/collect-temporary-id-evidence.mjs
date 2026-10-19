import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { hashTemporaryId, readTemporaryId, temporaryIdDirectory } from "./native-temporary-id-value.mjs";

const exec = promisify(execFile);
const cache = ".cache/temporary-id/evidence";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
mkdirSync(cache, { recursive: true });
let networkRequests = 0;
async function request(endpoint, args = [], binary = false) {
  const file = path.join(cache, `${hash(JSON.stringify([endpoint, args]))}.${binary ? "bin" : "json"}`);
  if (!existsSync(file)) {
    if (process.env.TEMPORARY_ID_OFFLINE === "1") throw new Error(`Unacquired temporary-ID evidence endpoint: ${endpoint}`);
    if (++networkRequests > 12000) throw new Error("Temporary-ID acquisition needs an explicit resumed request budget");
    try {
      const { stdout } = await exec("gh", ["api", endpoint, ...args, ...(binary ? ["--allow-escape-sequences"] : [])], {
        encoding: "buffer", timeout: 90000, maxBuffer: 32 * 1024 * 1024,
      });
      writeFileSync(file, stdout);
    } catch (error) {
      const status = String(error.stderr).match(/HTTP (\d+)/)?.[1];
      if (!["404", "410"].includes(status)) throw error;
      writeFileSync(file, JSON.stringify({ unavailable: true, status: Number(status), endpoint }));
    }
  }
  const bytes = readFileSync(file);
  if (binary && bytes[0] !== 123) return { bytes, digest: hash(bytes) };
  const json = JSON.parse(bytes);
  return binary ? json : { ...json, responseDigest: hash(bytes), acquiredAt: statSync(file).mtime.toISOString() };
}
async function pool(rows, action) {
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) await action(rows[next++]);
  }));
}
function write(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  writeFileSync(`${temporaryIdDirectory}/${file}`, file.endsWith(".gz") ? gzipSync(bytes) : bytes);
}
const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
const source = readTemporaryId(`${temporaryIdDirectory}/source-review.json.gz`);
const repository = await request("repos/github/gh-aw");
if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository) throw new Error("Wrong target repository");
const inventory = new Map();
const inventories = [];
async function interval(start, end) {
  const query = `repos/github/gh-aw/actions/workflows/smoke-temporary-id.lock.yml/runs?created=${encodeURIComponent(`${start}..${end}`)}&per_page=100`;
  const first = await request(`${query}&page=1`);
  if (!Array.isArray(first.workflow_runs) || !Number.isSafeInteger(first.total_count)) throw new Error("Invalid Actions inventory");
  if (first.total_count > 1000) {
    const mid = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2000) * 1000).toISOString().replace(".000Z", "Z");
    if (mid <= start || mid >= end) throw new Error("Actions inventory exceeds a one-second scope");
    await interval(start, mid);
    await interval(mid, end);
    return;
  }
  const pages = [first];
  for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) pages.push(await request(`${query}&page=${page}`));
  const rows = pages.flatMap(item => item.workflow_runs);
  if (rows.length !== first.total_count || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error("Incomplete Actions interval inventory");
  }
  inventories.push({ start, end, total: first.total_count, responses: pages.map(item => item.responseDigest) });
  for (const run of rows) {
    if (run.repository?.id !== contract.repositoryId || run.path.split("@")[0] !== ".github/workflows/smoke-temporary-id.lock.yml") {
      throw new Error("Actions workflow identity mismatch");
    }
    if (run.created_at >= contract.until || run.created_at < contract.adoption.adoptedAt) continue;
    inventory.set(run.id, run);
  }
}
await interval(contract.adoption.adoptedAt, contract.until);
const history = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
if (!history.index.complete || history.index.repository !== contract.repository || history.index.until !== contract.until) {
  throw new Error("Shared discovery inventory is incomplete or has the wrong cutoff");
}
const candidates = history.entities.filter(row => row.workflowReference?.workflowId === contract.workflowId
  || row.unverifiedWorkflowId === contract.workflowId);
write("output-candidates.json.gz", candidates);
const absent = [...new Set(candidates.map(row => Number(row.workflowReference?.runId)).filter(Boolean))]
  .filter(id => !inventory.has(id));
const absentRuns = [];
await pool(absent, async id => {
  const response = await request(`repos/github/gh-aw/actions/runs/${id}`);
  absentRuns.push({ id, unavailable: response.unavailable ?? false, status: response.status,
    createdAt: response.created_at ?? null, path: response.path ?? null, responseDigest: response.responseDigest });
  if (!response.unavailable && response.created_at >= contract.adoption.adoptedAt && response.created_at < contract.until) {
    if (response.path.split("@")[0] !== ".github/workflows/smoke-temporary-id.lock.yml") throw new Error("Candidate points to another workflow");
    inventory.set(id, response);
  }
});
const runs = [...inventory.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
console.log(JSON.stringify({ inventoryRuns: runs.length, candidates: candidates.length, absentRuns: absent.length }));
const observations = [];
await pool(runs, async run => {
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > 30) throw new Error("Invalid attempt identity");
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const jobs = await request(`repos/github/gh-aw/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
    if (!jobs.unavailable && (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)) {
      throw new Error("Incomplete protected job inventory");
    }
    const projectedJobs = (jobs.jobs ?? []).map(job => ({ id: job.id, name: job.name, status: job.status,
      conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
      steps: (job.steps ?? []).map(step => ({ name: step.name, number: step.number, conclusion: step.conclusion,
        startedAt: step.started_at, completedAt: step.completed_at })) }));
    const agent = projectedJobs.filter(job => job.name.toLowerCase() === "agent");
    const safe = projectedJobs.filter(job => job.name.toLowerCase().replaceAll(" ", "_") === "safe_outputs");
    const eligible = agent.some(job => job.startedAt && job.conclusion !== "skipped") ? true
      : agent.length && agent.every(job => job.conclusion === "skipped") ? false : null;
    const row = { id: `${run.id}:${attempt}`, runId: run.id, attempt, initial: attempt === 1,
      at: run.created_at, runCreatedAt: run.created_at, headSha: run.head_sha, event: run.event, headBranch: run.head_branch,
      runUrl: `${run.html_url}/attempts/${attempt}`,
      eligible, sourceBound: false, mapping: [], bodies: [], graph: [],
      jobsResponseDigest: jobs.responseDigest, jobs: projectedJobs, missing: [] };
    if (jobs.unavailable) row.missing.push("Protected Actions job history unavailable");
    if (eligible !== false && safe.some(job => job.startedAt && job.conclusion !== "skipped")) {
      const artifacts = await request(`repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100`);
      if (!artifacts.unavailable && artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete artifact inventory");
      row.artifactsResponseDigest = artifacts.responseDigest;
      row.artifacts = (artifacts.artifacts ?? []).map(item => ({ id: item.id, name: item.name, expired: item.expired,
        createdAt: item.created_at, expiresAt: item.expires_at, size: item.size_in_bytes, digest: item.digest }));
      for (const job of safe) {
        const log = await request(`repos/github/gh-aw/actions/jobs/${job.id}/logs`, [], true);
        row.hostLog = log.unavailable ? { unavailable: true, status: log.status }
          : { digest: log.digest, bytes: log.bytes.length,
            mappingLines: log.bytes.toString("utf8").split("\n").filter(line => /Stored temporary ID mapping:|Registered temporary ID:|Successfully linked issue|Updated issue.*#/.test(line))
              .map(line => line.slice(0, 500)) };
      }
      const receipts = row.artifacts.filter(item => item.name === "safe-outputs-items");
      row.receiptArtifacts = [];
      for (const artifact of receipts) {
        if (artifact.expired || artifact.size > 8 * 1024 * 1024) {
          row.receiptArtifacts.push({ id: artifact.id, missing: artifact.expired ? "expired" : "over-budget" });
          continue;
        }
        const archive = await request(`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, [], true);
        row.receiptArtifacts.push(archive.unavailable ? { id: artifact.id, missing: `HTTP ${archive.status}` }
          : { id: artifact.id, digest: archive.digest, bytes: archive.bytes.length,
            cacheFile: `${hash(JSON.stringify([`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, []]))}.bin` });
      }
      row.missing.push("Protected mapping and immutable runtime producer must be joined to historical body/graph facts; neither agent output nor successful host status is accepted alone");
    }
    if (!row.missing.length && eligible !== false) row.missing.push("No executed protected safe-output receipt establishes the mapping");
    observations.push(row);
  }
  if (observations.length % 100 === 0) console.log(`Inventoried ${observations.length} attempts`);
});
observations.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
for (let start = 0; start < candidates.length; start += 20) {
  const group = candidates.slice(start, start + 20);
  const fields = group.map(row => `i${row.number}:issue(number:${row.number}) {
    id number createdAt updatedAt lastEditedAt body
    parent { id number }
    subIssues(first:100) { totalCount nodes { id number } pageInfo { hasNextPage } }
    timelineItems(first:100,itemTypes:[SUB_ISSUE_ADDED_EVENT,SUB_ISSUE_REMOVED_EVENT,PARENT_ISSUE_ADDED_EVENT,PARENT_ISSUE_REMOVED_EVENT]) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { __typename ... on SubIssueAddedEvent { createdAt subIssue { id number } }
        ... on SubIssueRemovedEvent { createdAt subIssue { id number } }
        ... on ParentIssueAddedEvent { createdAt parent { id number } }
        ... on ParentIssueRemovedEvent { createdAt parent { id number } } }
    }
  }`).join("\n");
  const response = await request("graphql", ["-f", `query=query { repository(owner:"github",name:"gh-aw") { databaseId ${fields} } }`]);
  if (response.errors || response.data?.repository?.databaseId !== contract.repositoryId) throw new Error("Independent issue graph query failed");
  write(`github-graph-${String(start / 20 + 1).padStart(3, "0")}.json.gz`, { observedAt: response.acquiredAt,
    responseDigest: response.responseDigest, issues: group.map(row => response.data.repository[`i${row.number}`]) });
}
const partitions = [];
for (let offset = 0; offset < observations.length; offset += 100) {
  const rows = observations.slice(offset, offset + 100);
  const file = `observations-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
  write(file, rows);
  partitions.push({ file, count: rows.length, sha256: hashTemporaryId(rows) });
}
write("index.json", { schemaVersion: 1, workflowId: contract.workflowId, contractSha256: hashTemporaryId(contract),
  sourceReviewSha256: hashTemporaryId(source), inventoryComplete: true, runInventory: inventories,
  runCount: runs.length, attempts: observations.length, initialAttempts: runs.length,
  executedInitialAttempts: observations.filter(row => row.initial && row.eligible === true).length,
  unknownEligibility: observations.filter(row => row.initial && row.eligible === null).length,
  skippedInitialAttempts: observations.filter(row => row.initial && row.eligible === false).length,
  candidates: candidates.length, candidateRunGaps: absentRuns, partitions,
  observedAt: new Date().toISOString(), until: contract.until, networkRequests,
  evidenceReadiness: "blocked: protected receipt producer binding and historical body/graph join not yet established",
  limitations: ["Actions inventories cannot recover deleted runs; shared complete output discovery is cross-checked.",
    "Shared output inventory excludes deleted/transferred issues, comments and Discussions; candidate markers are never proof.",
    "Missing protected mapping, historical body state or graph history remains null. No measurement or trend is claimed."] });
console.log(JSON.stringify({ runs: runs.length, attempts: observations.length, networkRequests, evidenceReadiness: "blocked-pending-independent-join" }));
