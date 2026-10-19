import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { assessReusableArtifacts, reusableArtifactPaths, sha256 } from "./reusable-artifact-value.mjs";

const [bareCache, apiCache, phase = "collect"] = process.argv.slice(2);
if (!bareCache || !apiCache || !["inventory", "collect", "finalize"].includes(phase)) {
  throw new Error("Usage: node scripts/collect-reusable-artifact-value.mjs BARE_CACHE PRIVATE_API_CACHE [inventory|collect|finalize]");
}
const contract = readCensusJson(reusableArtifactPaths.contract);
const frozenSources = readCensusJson(`${reusableArtifactPaths.directory}/sources.json.gz`);
const frozenBlob = file => frozenSources.find(row => row.path === file && row.revision === contract.sourceRevision)?.gitBlob;
const reader = publicGitSourceReader(bareCache, contract.repository);
mkdirSync(apiCache, { recursive: true });
const probes = [];
function api(endpoint) {
  const file = path.join(apiCache, `${sha256(endpoint)}.json`);
  let response;
  if (existsSync(file)) response = JSON.parse(readFileSync(file, "utf8"));
  else {
    if (phase === "finalize") throw new Error(`Offline acquisition cache missing: ${endpoint}`);
    const bytes = execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"] });
    response = JSON.parse(bytes);
    writeFileSync(file, JSON.stringify(response));
  }
  probes.push({ endpoint, responseSha256: censusDigest(response) });
  return response;
}
const repo = api(`repos/${contract.repository}`);
if (repo.id !== contract.repositoryId || repo.full_name !== contract.repository) throw new Error("Repository identity changed");
const inventory = [];
const segments = [];
for (let start = contract.adoption.adoptedAt; start < contract.until;) {
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  date.setUTCHours(0, 0, 0, 0);
  const end = date.toISOString().replace(".000Z", "Z") < contract.until
    ? date.toISOString().replace(".000Z", "Z") : contract.until;
  segments.push({ start, end });
  start = end;
}
for (const workflow of ["smoke-multi-caller.yml", `${contract.workflowId}.lock.yml`]) {
  const runs = new Map();
  for (const { start, end } of segments) {
    const through = new Date(Date.parse(end) - 1000).toISOString().replace(".000Z", "Z");
    let count = 0, total = null;
    for (let page = 1; ; page++) {
      const response = api(`repos/${contract.repository}/actions/workflows/${workflow}/runs?created=${encodeURIComponent(`${start}..${through}`)}&per_page=100&page=${page}`);
      if (!Number.isSafeInteger(response.total_count) || response.total_count > 1000
        || !Array.isArray(response.workflow_runs)) throw new Error("Discovery segment exceeds provider limit; split before proceeding");
      total ??= response.total_count;
      if (total !== response.total_count) throw new Error("Discovery inventory changed during pagination");
      for (const row of response.workflow_runs) {
        if (runs.has(row.id) || row.created_at < start || row.created_at >= end
          || row.path?.split("@")[0] !== `.github/workflows/${workflow}`) throw new Error("Run identity/range mismatch");
        runs.set(row.id, { id: row.id, workflow, workflowId: row.workflow_id, headSha: row.head_sha,
          headRepositoryId: row.head_repository?.id, event: row.event, at: row.created_at,
          status: row.status, conclusion: row.conclusion, latestAttempt: row.run_attempt,
          referencedWorkflows: (row.referenced_workflows ?? []).map(reference => ({
            path: reference.path, sha: reference.sha, ref: reference.ref ?? null,
          })) });
        count++;
      }
      if (count === total) break;
      if (!response.workflow_runs.length || count > total) throw new Error("Incomplete run discovery");
    }
  }
  inventory.push(...runs.values());
}
inventory.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
writeCensusJson(`${reusableArtifactPaths.directory}/inventory.json.gz`, inventory);
console.log(JSON.stringify({ discovered: inventory.length,
  callerRuns: inventory.filter(row => row.workflow === "smoke-multi-caller.yml").length,
  callerNonSkipped: inventory.filter(row => row.workflow === "smoke-multi-caller.yml" && row.conclusion !== "skipped").length,
  directRuns: inventory.filter(row => row.workflow !== "smoke-multi-caller.yml").length }));
if (phase === "inventory") process.exit(0);

async function prefetch(endpoints) {
  if (phase === "finalize") return;
  let cursor = 0;
  await Promise.all(Array.from({ length: 1 }, async () => {
    while (cursor < endpoints.length) {
      const endpoint = endpoints[cursor++];
      const file = path.join(apiCache, `${sha256(endpoint)}.json`);
      if (existsSync(file)) continue;
      const bytes = await new Promise((resolve, reject) => execFile("gh", ["api", endpoint],
        { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const value = JSON.parse(bytes);
      writeFileSync(file, JSON.stringify(value));
    }
  }));
}
const callers = inventory.filter(row => row.workflow === "smoke-multi-caller.yml");
await prefetch(callers.filter(row => row.latestAttempt !== 1)
  .map(row => `repos/${contract.repository}/actions/runs/${row.id}/attempts/1`));
const candidates = callers.filter(row => {
  const conclusion = row.latestAttempt === 1 ? row.conclusion
    : api(`repos/${contract.repository}/actions/runs/${row.id}/attempts/1`).conclusion;
  return conclusion !== "skipped";
});
await prefetch(candidates.flatMap(row => [
  `repos/${contract.repository}/actions/runs/${row.id}/attempts/1/jobs?per_page=100&page=1`,
  `repos/${contract.repository}/actions/runs/${row.id}/artifacts?per_page=100&page=1`,
]));
let logCursor = 0;
await Promise.all(Array.from({ length: phase === "finalize" ? 0 : 1 }, async () => {
  while (logCursor < candidates.length) {
    const row = candidates[logCursor++];
    const file = path.join(apiCache, `${row.id}-attempt-1-log-probe.json`);
    if (existsSync(file)) continue;
    const result = await new Promise((resolve, reject) => execFile("gh",
      ["api", `repos/${contract.repository}/actions/runs/${row.id}/attempts/1/logs`],
      { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
        if (!error) {
          writeFileSync(path.join(apiCache, `${row.id}-attempt-1-logs.zip`), stdout);
          resolve({ status: "available-uninterpreted", sha256: sha256(stdout), bytes: stdout.length });
        } else if (/\b(404|410)\b|expired|not found/i.test(String(stderr))) {
          resolve({ status: "unavailable", httpStatus: /\b410\b/.test(String(stderr)) ? 410 : 404,
            reason: "Provider does not supply initial-attempt logs; absence does not prove no execution." });
        } else reject(error);
      }));
    writeFileSync(file, JSON.stringify(result));
  }
}));

function paginated(endpoint, field) {
  const rows = [];
  let total;
  for (let page = 1; ; page++) {
    const response = api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    total ??= response.total_count;
    if (!Number.isSafeInteger(total) || total !== response.total_count || !Array.isArray(response[field])) {
      throw new Error(`Invalid ${field} inventory`);
    }
    rows.push(...response[field]);
    if (rows.length === total) break;
    if (!response[field].length || rows.length > total) throw new Error(`Incomplete ${field} inventory`);
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`Duplicate ${field} identities`);
  return rows;
}
const observations = [], sources = [];
for (const run of inventory.filter(row => row.workflow === "smoke-multi-caller.yml")) {
  let original = run;
  if (run.latestAttempt !== 1) {
    const attempt = api(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1`);
    if (attempt.id !== run.id || attempt.run_attempt !== 1 || attempt.head_sha !== run.headSha) {
      throw new Error("Initial attempt identity changed");
    }
    original = { ...run, conclusion: attempt.conclusion, status: attempt.status,
      referencedWorkflows: (attempt.referenced_workflows ?? []).map(reference => ({
        path: reference.path, sha: reference.sha, ref: reference.ref ?? null,
      })) };
  }
  if (original.conclusion === "skipped") {
    observations.push({ runId: run.id, headSha: run.headSha, at: run.at, eligible: false,
      referencedWorkflows: original.referencedWorkflows,
      exclusion: "Provider initial-attempt run conclusion is skipped; no caller invocation executed.",
      inventoryComplete: true, sourceBound: false, invocations: [] });
    continue;
  }
  const jobs = paginated(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1/jobs`, "jobs");
  const projectJobs = jobs.map(job => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
    started_at: job.started_at, completed_at: job.completed_at,
    steps: job.steps?.map(step => ({ name: step.name, number: step.number, status: step.status,
      conclusion: step.conclusion, started_at: step.started_at, completed_at: step.completed_at })) ?? [] }));
  const invocationJobs = projectJobs.filter(job => /^task-[abc]\s*\//.test(job.name));
  if (!invocationJobs.length || invocationJobs.every(job => job.conclusion === "skipped")) {
    const artifacts = paginated(`repos/${contract.repository}/actions/runs/${run.id}/artifacts`, "artifacts")
      .map(row => ({ id: row.id, name: row.name, expired: row.expired, digest: row.digest ?? null,
        size: row.size_in_bytes, runId: row.workflow_run?.id ?? null, headSha: row.workflow_run?.head_sha ?? null }));
    const logProbeFile = path.join(apiCache, `${run.id}-attempt-1-log-probe.json`);
    const logProbe = existsSync(logProbeFile) ? JSON.parse(readFileSync(logProbeFile, "utf8"))
      : { status: "not-acquired", reason: "GitHub core API quota exhausted during exhaustive log acquisition (HTTP 403); resume required." };
    observations.push({ runId: run.id, headSha: run.headSha, at: run.at, eligible: null,
      referencedWorkflows: original.referencedWorkflows,
      reason: "No source-bound caller jobs retained. Empty or unrelated result-check jobs do not prove that an eligible invocation never existed.",
      originalConclusion: original.conclusion, artifacts, logProbe,
      jobs: projectJobs, inventoryComplete: true, sourceBound: false, invocations: [] });
    continue;
  }
  const artifacts = paginated(`repos/${contract.repository}/actions/runs/${run.id}/artifacts`, "artifacts")
    .map(artifact => ({ id: artifact.id, name: artifact.name, expired: artifact.expired,
      digest: artifact.digest ?? null, size: artifact.size_in_bytes, created_at: artifact.created_at,
      updated_at: artifact.updated_at, runId: artifact.workflow_run?.id ?? run.id,
      headSha: artifact.workflow_run?.head_sha ?? null }));
  let sourceBound = false;
  const reasons = [];
  if (run.headRepositoryId !== contract.repositoryId) reasons.push("Head repository is outside the frozen authorized source.");
  else {
    const references = original.referencedWorkflows.filter(reference =>
      reference.path?.split("@")[0] === `${contract.repository}/${contract.sourcePath.replace(".md", ".lock.yml")}`
      && /^[a-f0-9]{40}$/.test(reference.sha ?? ""));
    const executionSha = references.length === 1 ? references[0].sha
      : run.event.startsWith("pull_request") ? null : run.headSha;
    if (!executionSha) throw new Error("Executed caller has no unique immutable reusable-source receipt; retain and resolve before source replay");
    const sourceKey = `${executionSha}:${run.event}`;
    let source = sources.find(row => row.key === sourceKey);
    if (!source) {
      try { reader.metadata(["cat-file", "-e", `${executionSha}^{commit}`]); }
      catch (error) {
        if (error.status !== 128) throw error;
        if (phase === "finalize") throw new Error("Immutable reusable source is not cached; offline finalization must not acquire it");
        execFileSync("git", [`--git-dir=${bareCache}`, "fetch", "--quiet", "--filter=blob:none", "--no-tags", "origin", executionSha],
          { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      }
      const caller = reader.read(executionSha, ".github/workflows/smoke-multi-caller.yml");
      const callee = reader.read(executionSha, contract.sourcePath);
      const lock = reader.read(executionSha, contract.sourcePath.replace(".md", ".lock.yml"));
      const prefix = reader.read(executionSha, "actions/setup/sh/compute_artifact_prefix.sh");
      const parsed = caller ? parse(caller.bytes.toString()) : null;
      const actual = parsed ? Object.fromEntries(Object.entries(parsed.jobs).map(([id, job]) => [id,
        { with: job.with, needs: job.needs ?? [], uses: job.uses }])) : null;
      source = { key: sourceKey, headSha: run.headSha, executionSha,
        caller: caller?.id ?? null, callee: callee?.id ?? null, lock: lock?.id ?? null, prefix: prefix?.id ?? null,
        callerCompatible: censusDigest(actual) === censusDigest(contract.callerJobs),
        sourceStatus: references.length === 1 ? "immutable-reusable-source-receipt" : "immutable-head",
        sources: [caller, callee, lock, prefix].filter(Boolean).map(row => ({ path: row.path, gitBlob: row.id,
          sha256: row.sha256, content: row.bytes.toString("base64") })) };
      sources.push(source);
    }
    sourceBound = source.callerCompatible && source.callee === contract.sourceGitBlob
      && source.lock === frozenBlob(contract.sourcePath.replace(".md", ".lock.yml"))
      && source.prefix === frozenBlob("actions/setup/sh/compute_artifact_prefix.sh");
    if (!sourceBound) reasons.push(source.sourceStatus === "merge-checkout-unresolved"
      ? "PR head does not establish actual merge-checkout caller/callee execution identity."
      : "Historical caller/callee profile differs; original source retained, not relabeled as current.");
  }
  const invocations = Object.keys(contract.callerJobs).map(caller => ({
    caller, input: contract.callerJobs[caller].with, prefix: null, artifacts: [],
    payloadCorrect: null, consumerCorrect: null,
  }));
  reasons.push(artifacts.length ? "Provider metadata does not independently bind invocation inputs to payload contents and protected readback."
    : "Complete provider artifact inventory is empty; expired/deleted payloads cannot prove isolation or failure.");
  // Log availability is probed independently of artifact retention; no agent text is used as an oracle.
  let logProbe;
  try {
    const bytes = execFileSync("gh", ["api", `repos/${contract.repository}/actions/runs/${run.id}/attempts/1/logs`],
      { timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    logProbe = { status: "available-uninterpreted", sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(path.join(apiCache, `${run.id}-attempt-1-logs.zip`), bytes);
  } catch (error) {
    const text = String(error.stderr ?? "");
    if (!/\b(404|410)\b|expired|not found/i.test(text)) throw error;
    logProbe = { status: "unavailable", httpStatus: /\b410\b/.test(text) ? 410 : 404,
      reason: "Provider no longer retains initial-attempt logs." };
  }
  observations.push({ runId: run.id, headSha: run.headSha, at: run.at, eligible: true,
    referencedWorkflows: original.referencedWorkflows,
    sourceBound, inventoryComplete: true, jobs: projectJobs, artifacts, invocations,
    logProbe, reasons, attained: null });
  console.log(JSON.stringify({ runId: run.id, jobs: jobs.length, artifacts: artifacts.length, sourceBound, log: logProbe.status }));
}
writeCensusJson(`${reusableArtifactPaths.directory}/observations.json.gz`, observations);
writeCensusJson(`${reusableArtifactPaths.directory}/execution-sources.json.gz`, sources);
const eligible = observations.filter(row => row.eligible !== false);
const index = { schemaVersion: 1, repository: contract.repository, workflowId: contract.workflowId,
  complete: true, discoveryComplete: true, outcomeEvidenceReady: eligible.some(row => assessReusableArtifacts(row) !== null),
  acquisitionComplete: eligible.every(row => row.logProbe?.status !== "not-acquired"),
  readiness: "open-blocked",
  contractSha256: censusDigest(contract), observations: observations.length,
  observationsSha256: censusDigest(observations), inventorySha256: censusDigest(inventory),
  sourceProfiles: sources.length, sourcesSha256: censusDigest(sources),
  callerRuns: observations.length, directRuns: inventory.length - observations.length,
  candidateScenarios: eligible.length, eligibleScenarios: eligible.filter(row => row.eligible === true).length,
  unresolvedEligibility: eligible.filter(row => row.eligible === null).length,
  originalAttemptsWithReusableSourceReceipt: observations.filter(row => row.referencedWorkflows?.some(reference =>
    reference.path?.split("@")[0] === `${contract.repository}/${contract.sourcePath.replace(".md", ".lock.yml")}`
      && /^[a-f0-9]{40}$/.test(reference.sha ?? ""))).length,
  excludedScenarios: observations.length - eligible.length,
  verifiedScenarios: eligible.filter(row => assessReusableArtifacts(row) === true).length,
  rejectedScenarios: eligible.filter(row => assessReusableArtifacts(row) === false).length,
  unknownScenarios: eligible.filter(row => assessReusableArtifacts(row) === null).length,
  retainedArtifacts: eligible.reduce((sum, row) => sum + row.artifacts.length, 0),
  probes, sourceRevision: contract.sourceRevision, until: contract.until };
writeCensusJson(reusableArtifactPaths.index, index);
console.log(JSON.stringify({ ...index, probes: index.probes.length }));
