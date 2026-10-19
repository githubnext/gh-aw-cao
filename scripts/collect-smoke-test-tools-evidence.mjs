import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { smokeToolsContract as contract } from "./smoke-test-tools-contract.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const evidenceDirectory = "docs/operational-value/proof/smoke-test-tools";
class MissingCachedEvidence extends Error {}
export const smokeToolsQuotaFailure = stderr => /HTTP 429/.test(String(stderr))
  || /HTTP 403/.test(String(stderr)) && /rate limit/i.test(String(stderr));
export const retryableSmokeToolsLogStatus = status => ["not-acquired-rate-limited", "HTTP 403",
  "unresolved-403-access-or-quota"].includes(status);
export async function acquireSmokeTools(cache, sourcesOnly = false, cacheOnly = false) {
  mkdirSync(cache, { recursive: true });
  mkdirSync(evidenceDirectory, { recursive: true });
  let remoteRequests = 0;
  let quotaBlocked = false;
  const api = async endpoint => {
    const file = path.join(cache, `${digest(endpoint)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (cacheOnly || quotaBlocked) throw new MissingCachedEvidence(`No retained response for ${endpoint}`);
    remoteRequests++;
    let stdout;
    try {
      ({ stdout } = await execute("gh", ["api", endpoint], {
        maxBuffer: 32 * 1024 * 1024, timeout: 90000, env: { ...process.env, GH_PAGER: "cat" },
      }));
    } catch (error) {
      if (!smokeToolsQuotaFailure(error.stderr)) throw error;
      quotaBlocked = true;
      throw new MissingCachedEvidence(`Quota blocked response for ${endpoint}`);
    }
    const value = JSON.parse(stdout);
    writeFileSync(file, JSON.stringify(value));
    return value;
  };
  const repository = await api(`repos/${contract.repository}`);
  if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository) throw new Error("Repository authority changed");
  const sourceRows = [];
  const source = async (file, ref) => {
    const row = await api(`repos/${contract.repository}/contents/${file}?ref=${ref}`);
    if (row.type !== "file" || row.encoding !== "base64") throw new Error("Invalid immutable source response");
    const bytes = verifyPublicGitBlob(Buffer.from(row.content, "base64"), row.sha);
    sourceRows.push({ path: file, revision: ref, gitBlob: row.sha, sha256: digest(bytes), content: bytes.toString("base64") });
    return bytes.toString("utf8");
  };
  const history = [];
  for (let page = 1; ; page++) {
    const rows = await api(`repos/${contract.repository}/commits?path=.github/workflows/smoke-test-tools.md&sha=${contract.sourceRevision}&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Incomplete source history");
    history.push(...rows.map(row => ({ commit: row.sha, at: row.commit.committer.date })));
    if (rows.length < 100) break;
  }
  for (const row of history) await source(".github/workflows/smoke-test-tools.md", row.commit);
  const files = [".github/workflows/smoke-test-tools.md", ".github/workflows/smoke-test-tools.lock.yml",
    ".github/workflows/shared/otlp.md", ".github/workflows/shared/token-telemetry-check.md",
    ".github/workflows/shared/reporting.md", ".github/workflows/shared/playwright-title-test.md",
    "actions/setup/js/pi_session.cjs", "actions/setup/js/codex_session.cjs",
    "actions/setup/js/shell_harness.cjs", "actions/setup/js/process_runner.cjs",
    "actions/setup/sh/run_awf_with_startup_retries.sh"];
  for (const file of files) await source(file, contract.sourceRevision);
  const adoption = await api(`repos/${contract.repository}/commits/${contract.adoption.commit}`);
  if (adoption.parents[0]?.sha !== contract.adoption.baselineCommit
    || ![".github/workflows/smoke-test-tools.md", ".github/workflows/smoke-test-tools.lock.yml"]
      .every(file => adoption.files.some(row => row.filename === file && row.status === "added"))) throw new Error("False adoption");
  writeCensusJson(`${evidenceDirectory}/sources.json.gz`, { contractSha256: censusDigest(contract), history, sources: sourceRows });
  if (sourcesOnly) return { sourceRevisions: history.length, remoteRequests };
  const inventory = new Map(), slices = [];
  const traverse = async (start, end) => {
    const expression = `${start}..${end}`;
    const endpoint = `repos/${contract.repository}/actions/workflows/smoke-test-tools.lock.yml/runs?created=${encodeURIComponent(expression)}&per_page=100`;
    const first = await api(`${endpoint}&page=1`);
    if (!Number.isSafeInteger(first.total_count) || !Array.isArray(first.workflow_runs)) throw new Error("Invalid run inventory");
    if (first.total_count >= 1000) {
      const middle = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2000) * 1000).toISOString().replace(".000Z", "Z");
      if (middle === start || middle === end) throw new Error("Run inventory exceeds one-second source limit");
      await traverse(start, middle);
      await traverse(middle, end);
      return;
    }
    const rows = [...first.workflow_runs];
    for (let page = 2; rows.length < first.total_count; page++) {
      const next = await api(`${endpoint}&page=${page}`);
      if (next.total_count !== first.total_count || !next.workflow_runs?.length) throw new Error("Run inventory changed or stopped early");
      rows.push(...next.workflow_runs);
    }
    if (rows.length !== first.total_count || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Run inventory count mismatch");
    const projected = rows.map(row => ({ id: row.id, run_attempt: row.run_attempt, head_sha: row.head_sha,
      event: row.event, created_at: row.created_at, status: row.status, conclusion: row.conclusion, path: row.path,
      repository: { id: row.repository?.id }, head_repository: { id: row.head_repository?.id } }));
    slices.push({ start, end, total: projected.length, sha256: censusDigest(projected) });
    for (const row of projected) {
      if (row.created_at < contract.adoption.adoptedAt || row.created_at >= contract.until) continue;
      if (!Number.isSafeInteger(row.id) || row.repository?.id !== contract.repositoryId
        || row.path.split("@")[0] !== ".github/workflows/smoke-test-tools.lock.yml") throw new Error("Run scope mismatch");
      if (inventory.has(row.id) && censusDigest(inventory.get(row.id)) !== censusDigest(row)) throw new Error("Conflicting boundary run");
      inventory.set(row.id, row);
    }
  };
  await traverse(contract.adoption.adoptedAt, contract.until);
  const rows = [...inventory.values()].sort((a, b) => a.id - b.id);
  writeCensusJson(`${evidenceDirectory}/runs.json.gz`, { complete: true, slices, rows });
  const observations = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const run = rows[next++];
      const row = { runId: run.id, at: run.created_at, event: run.event, headSha: run.head_sha,
        latestAttempt: run.run_attempt, latestConclusion: run.conclusion, headRepositoryId: run.head_repository?.id,
        jobs: null, jobsStatus: null, logStatus: null, artifacts: null, nativeProofs: [] };
      if (run.conclusion === "skipped" && run.run_attempt === 1) {
        row.jobsStatus = "initial-run-skipped";
        observations.push(row);
        continue;
      }
      try {
        const all = [];
        for (let page = 1; ; page++) {
          const response = await api(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=${page}`);
          if (!Array.isArray(response.jobs) || !Number.isSafeInteger(response.total_count)) throw new Error("Invalid jobs inventory");
          all.push(...response.jobs);
          if (all.length === response.total_count) break;
          if (!response.jobs.length || all.length > response.total_count) throw new Error("Incomplete jobs inventory");
        }
        row.jobs = all.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion, status: job.status,
          started_at: job.started_at, completed_at: job.completed_at, steps: job.steps?.map(step => ({
            name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
            started_at: step.started_at, completed_at: step.completed_at,
          })) }));
        row.jobsStatus = all.length ? "available" : "empty-initial-job-history";
      } catch (error) {
        if (error instanceof MissingCachedEvidence) row.jobsStatus = "not-acquired-rate-limited";
        else {
          if (!/HTTP (404|410)/.test(error.stderr ?? "")) throw error;
          row.jobsStatus = String(error.stderr).match(/HTTP \d+/)[0];
        }
      }
      const agent = row.jobs?.filter(job => job.name.toLowerCase() === "agent");
      const steps = agent?.flatMap(job => job.steps ?? []).filter(step => /^Execute (?:Pi|GitHub Copilot|Codex) CLI$/.test(step.name));
      row.execution = steps?.length === 1 ? steps[0] : null;
      if (row.execution && row.execution.conclusion !== "skipped" || !row.jobs?.length) {
        const endpoint = `repos/${contract.repository}/actions/runs/${run.id}/attempts/1/logs`;
        const file = path.join(cache, `${digest(endpoint)}.zip`), statusFile = `${file}.status.json`;
        const cachedStatus = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile)).status : null;
        if (!existsSync(file) && (!cachedStatus || retryableSmokeToolsLogStatus(cachedStatus)) && !cacheOnly && !quotaBlocked) {
          try {
            remoteRequests++;
            const { stdout } = await execute("gh", ["api", endpoint], { encoding: "buffer", timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
            writeFileSync(file, stdout);
          } catch (error) {
            if (!/HTTP (403|404|410|429)/.test(String(error.stderr))) throw error;
            if (smokeToolsQuotaFailure(error.stderr)) quotaBlocked = true;
            writeFileSync(statusFile, JSON.stringify({ status: smokeToolsQuotaFailure(error.stderr)
              ? "not-acquired-rate-limited" : String(error.stderr).match(/HTTP \d+/)[0] }));
          }
        }
        row.logStatus = existsSync(file) ? "available" : existsSync(statusFile)
          ? JSON.parse(readFileSync(statusFile)).status : "not-acquired-rate-limited";
        if (row.logStatus === "HTTP 403") row.logStatus = "unresolved-403-access-or-quota";
        if (existsSync(file)) {
          const bytes = readFileSync(file);
          row.logsSha256 = digest(bytes);
          if (bytes.toString("hex") === "504b0506000000000000000000000000000000000000") {
            row.logStatus = "empty-initial-attempt-log-archive";
            row.logEntries = [];
          } else {
            const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1024 * 1024 });
            row.logEntries = listing.trim().split("\n");
          }
        }
        try {
          const response = await api(`repos/${contract.repository}/actions/runs/${run.id}/artifacts?per_page=100`);
          if (response.artifacts.length !== response.total_count) throw new Error("Incomplete artifact inventory");
          row.artifacts = response.artifacts.map(artifact => ({ id: artifact.id, name: artifact.name,
            expired: artifact.expired, digest: artifact.digest, created_at: artifact.created_at, size_in_bytes: artifact.size_in_bytes }));
        } catch (error) {
          if (!(error instanceof MissingCachedEvidence)) throw error;
          row.artifactGap = "not-acquired-rate-limited";
        }
      } else row.logStatus = "no-initial-agent-execution";
      observations.push(row);
      if (observations.length % 100 === 0) console.error(`smoke-test-tools: ${observations.length}/${rows.length} initial executions inventoried`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  observations.sort((a, b) => a.runId - b.runId);
  writeCensusJson(`${evidenceDirectory}/observations.json.gz`, observations);
  const index = { schemaVersion: 1, contractSha256: censusDigest(contract), complete: observations.length === rows.length,
    acquisitionComplete: !observations.some(row => [row.jobsStatus, row.logStatus, row.artifactGap]
      .some(status => ["not-acquired-rate-limited", "unresolved-403-access-or-quota"].includes(status))),
    until: contract.until, runs: rows.length, observationsSha256: censusDigest(observations),
    sourcesSha256: digest(readFileSync(`${evidenceDirectory}/sources.json.gz`)),
    runsSha256: digest(readFileSync(`${evidenceDirectory}/runs.json.gz`)),
    jobs: Object.fromEntries([...new Set(observations.map(row => row.jobsStatus))].map(status => [status, observations.filter(row => row.jobsStatus === status).length])),
    logs: Object.fromEntries([...new Set(observations.map(row => row.logStatus))].map(status => [status, observations.filter(row => row.logStatus === status).length])),
    retainedProofs: 0, evidenceReady: false, remoteRequests };
  writeCensusJson(`${evidenceDirectory}/index.json`, index);
  return index;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await acquireSmokeTools(process.argv[2] ?? ".smoke-test-tools-cache/api",
    process.argv.includes("--sources"), process.argv.includes("--cache-only")), null, 2));
}
