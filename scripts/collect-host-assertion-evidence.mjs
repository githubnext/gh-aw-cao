import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { parseSpecTree } from "./collect-spec-condition-history.mjs";
import { HostLogEvidenceGap, parseExperimentAssignmentLog, readProtectedHostLog } from "./protected-host-log.mjs";
import { readProtectedExperimentJobLog } from "./protected-experiment-job-log.mjs";

const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
class NativeEvidenceGap extends Error {}

export function reviewedHostSourceProfile(contract, actual) {
  return [contract, ...(contract.historicalSourceProfiles ?? [])].find(profile =>
    ["jobs", "dependencies", "runtimeTrees"].every(key =>
      censusDigest(profile[key] ?? []) === censusDigest(actual[key] ?? []))) ?? null;
}

export function verifiedHostStep(step, until) {
  const start = Date.parse(step?.started_at), end = Date.parse(step?.completed_at);
  return step?.status === "completed" && step.conclusion === "success"
    && Number.isFinite(start) && Number.isFinite(end) && end >= start && end < Date.parse(until);
}

export function hostGateObservation(contract, gate, response, experiment = null) {
  if (!Array.isArray(response.jobs) || !Number.isSafeInteger(response.total_count)
    || response.total_count !== response.jobs.length) throw new Error("Incomplete native host job inventory");
  const expected = contract.jobs[gate.job].name;
  const matches = response.jobs.filter(job => job.name === expected)
    .flatMap(job => (job.steps ?? []).filter(step => step.name === gate.name).map(step => ({ job, step })));
  if (matches.length !== 1) return { passed: null, reason: "No unique source-bound native host assertion step." };
  const { job, step } = matches[0];
  if (!positive(job.id) || !positive(step.number)) throw new Error("Invalid native host assertion receipt identity");
  let conditional = !gate.experiment, conditionGap = null;
  if (gate.experiment && experiment?.status === "available") {
    const policy = gate.experiment;
    try {
      const parsed = parseExperimentAssignmentLog(experiment.assignmentLine, policy.name, experiment.selectorReceipt, policy.variants);
      const selectors = response.jobs.filter(job => job.name === contract.jobs[policy.job].name)
        .flatMap(job => (job.steps ?? []).filter(step => step.name === policy.step).map(step => ({ job, step })));
      const matchingEntry = typeof experiment.hostEntry === "string"
        && (experiment.logLayout === "protected-job-step-interval" && contract.conditionJobOracleSha256
          ? experiment.hostEntry.match(/^\d+_(.+)\.txt$/)?.[1] === experiment.jobName
          : experiment.hostEntry.startsWith(`${experiment.jobName}/`) && experiment.hostEntry.endsWith(`_${policy.step}.txt`));
      conditional = parsed.experiment === experiment.experiment && parsed.variant === experiment.variant
        && policy.positiveVariants.includes(parsed.variant) && selectors.length === 1
        && selectors[0].job.id === experiment.jobId
        && censusDigest(selectors[0].step) === censusDigest(experiment.selectorReceipt)
        && experiment.jobName === contract.jobs[policy.job].name
        && positive(experiment.jobId) && positive(experiment.selectorReceipt.number)
        && verifiedHostStep(experiment.selectorReceipt, contract.until)
        && /^[a-f0-9]{64}$/.test(experiment.archiveSha256) && /^[a-f0-9]{64}$/.test(experiment.hostLogSha256)
        && matchingEntry;
      conditionGap = conditional ? null : "Synthetic control or unbound selector receipt establishes no positive capability.";
    } catch (error) {
      if (!(error instanceof HostLogEvidenceGap)) throw error;
      conditionGap = error.message;
    }
  }
  const native = verifiedHostStep(step, contract.until);
  return { passed: native && conditional ? true : null,
    reason: !native ? "Native conjunction did not establish this predicate before cutoff."
      : conditional ? null : conditionGap ?? experiment?.reason ?? "No independent protected experiment assignment.",
    receipt: { jobId: job.id, number: step.number, status: step.status, conclusion: step.conclusion,
      started_at: step.started_at, completed_at: step.completed_at, ...(experiment ? { experiment } : {}) } };
}

function normalizedJobs(response) {
  if (!Array.isArray(response.jobs)) throw new Error("Invalid native host jobs response");
  return { total_count: response.total_count, jobs: response.jobs.map(job => ({
    id: job.id, name: job.name, steps: (job.steps ?? []).map(step => ({
      name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
      started_at: step.started_at, completed_at: step.completed_at,
    })),
  })) };
}

export function collectHostAssertionEvidence(bareCache, apiCache) {
  const directory = "docs/operational-value/proof/host-assertions";
  const contracts = readCensusJson(`${directory}/contracts.json`);
  mkdirSync(apiCache, { recursive: true });
  const git = args => execFileSync("git", [`--git-dir=${bareCache}`, ...args],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  if (git(["remote", "get-url", "origin"]) !== "https://github.com/github/gh-aw.git") throw new Error("Unexpected host source remote");
  let requests = 0, bytesRead = 0, fetchedHeads = 0;
  const request = (endpoint, normalize) => {
    const key = createHash("sha256").update(endpoint).digest("hex"), file = path.join(apiCache, `${key}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (++requests > 1600) throw new Error("Native host API budget exhausted");
    const bytes = execFileSync("gh", ["api", endpoint], { maxBuffer: 32 * 1024 * 1024, timeout: 60000,
      env: { ...process.env, GH_PAGER: "cat" } });
    bytesRead += bytes.length;
    if (bytesRead > 256 * 1024 * 1024) throw new Error("Native host API byte budget exhausted");
    const value = normalize(JSON.parse(bytes));
    writeFileSync(file, JSON.stringify(value));
    return value;
  };
  const repository = request("repos/github/gh-aw", row => ({ id: row.id, full_name: row.full_name }));
  if (repository.id !== 1036865607 || repository.full_name !== "github/gh-aw") throw new Error("Native host repository identity changed");
  const results = [];
  for (const contract of contracts) {
    if (contract.repository !== repository.full_name || contract.repositoryId !== repository.id) throw new Error("Native host contract scope changed");
    if (contract.conditionOracleSha256
      && createHash("sha256").update(readFileSync("scripts/protected-host-log.mjs")).digest("hex") !== contract.conditionOracleSha256) {
      throw new Error("Frozen conditional host-log oracle changed");
    }
    if (contract.conditionJobOracleSha256
      && createHash("sha256").update(readFileSync("scripts/protected-experiment-job-log.mjs")).digest("hex") !== contract.conditionJobOracleSha256) {
      throw new Error("Frozen protected experiment-job oracle changed");
    }
    const indexPath = `${directory}/${contract.workflowId}-index.json`;
    if (existsSync(indexPath)) {
      const index = readCensusJson(indexPath);
      if (!index.complete || index.contractSha256 !== censusDigest(contract)) throw new Error("Existing native host acquisition scope changed");
      for (const part of index.partitions) {
        if (!/^[a-z0-9-]+-observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe retained host assertion partition");
        const rows = readCensusJson(`${directory}/${part.file}`);
        if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Retained host assertion facts changed");
      }
      results.push({ workflowId: contract.workflowId, observations: index.observations, proven: index.proven, reused: true });
      continue;
    }
    const execution = `.github/workflows/${contract.workflowId}.lock.yml`, locks = new Set();
    for (const commit of git(["log", "--first-parent", "--format=%H",
      `${contract.adoption.baselineCommit}..${contract.sourceRevision}`, "--", execution]).split("\n").filter(Boolean)) {
      const record = git(["ls-tree", commit, "--", execution]);
      if (record) locks.add(record.split(/\s+/)[2]);
    }
    const inventory = new Map();
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const interval = encodeURIComponent(`${contract.adoption.adoptedAt}..${contract.until}`);
      const response = request(`repos/github/gh-aw/actions/workflows/${contract.workflowId}.lock.yml/runs?created=${interval}&per_page=100&page=${page}`, response => ({
        total_count: response.total_count, workflow_runs: response.workflow_runs?.map(run => ({
          id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha, path: run.path,
          event: run.event, created_at: run.created_at, headRepositoryId: run.head_repository?.id ?? null,
        })),
      }));
      if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.total_count > 1000
        || !Array.isArray(response.workflow_runs)) throw new Error("Invalid or over-budget native host execution inventory");
      for (const run of response.workflow_runs) {
        if (!positive(run.id) || !positive(run.run_attempt) || !sha(run.head_sha) || typeof run.event !== "string"
          || !Number.isFinite(Date.parse(run.created_at))
          || run.path?.split("@")[0] !== execution || inventory.has(run.id)) {
          throw new Error("Invalid or duplicated native host run identity");
        }
        inventory.set(run.id, run);
      }
      if (inventory.size === response.total_count) { complete = true; break; }
      if (!response.workflow_runs.length) throw new Error("Native host inventory traversal stopped early");
    }
    if (!complete) throw new Error("Native host inventory is incomplete");
    const observations = [], sources = new Map();
    for (const run of inventory.values()) {
      if (run.created_at >= contract.until) continue;
      const sourceKey = `${run.headRepositoryId}:${run.head_sha}:${run.event.startsWith("pull_request") ? "pull-request" : "checkout"}`;
      if (!sources.has(sourceKey)) {
        let validation = null, reason = null;
        try {
          if (run.headRepositoryId !== repository.id) throw new NativeEvidenceGap("No authorized same-repository execution source.");
          if (run.event.startsWith("pull_request")) throw new NativeEvidenceGap("No independent PR merge-ref checkout receipt.");
          try { git(["cat-file", "-e", `${run.head_sha}^{commit}`]); }
          catch (error) {
            if (!/Not a valid object name|could not get object info|bad object/i.test(String(error.stderr))) throw error;
            if (++fetchedHeads > 200) throw new Error("Native host Git-head acquisition budget exhausted");
            git(["fetch", "--quiet", "--filter=blob:none", "--no-tags", "origin", run.head_sha]);
          }
          const tree = parseSpecTree(git(["ls-tree", "-rz", run.head_sha, "--",
            execution, ...contract.dependencies.map(row => row.path)]));
          const lock = tree.get(execution);
          if (!lock || lock.mode !== "100644" || !locks.has(lock.blob)) {
            throw new NativeEvidenceGap("Execution lock is not in reviewed frozen mainline history.");
          }
          const actual = parse(git(["show", `${run.head_sha}:${execution}`]));
          const actualJobs = {};
          for (const id of Object.keys(contract.jobs)) {
            if (!actual.jobs?.[id]) throw new NativeEvidenceGap(`No native verifier job in this historical workflow: ${id}`);
            actualJobs[id] = { name: actual.jobs[id].name ?? id, sha256: censusDigest(actual.jobs[id]) };
          }
          const dependencies = [];
          for (const dependency of contract.dependencies) {
            const source = tree.get(dependency.path);
            if (!source || !["100644", "100755"].includes(source.mode)) throw new NativeEvidenceGap(`Missing native checker dependency: ${dependency.path}`);
            dependencies.push({ path: dependency.path, gitBlob: source.blob });
          }
          const runtimeTrees = [];
          for (const runtime of contract.runtimeTrees ?? []) {
            const record = git(["ls-tree", "-d", run.head_sha, "--", runtime.path]).split(/\s+/);
            if (record[0] !== "040000") throw new NativeEvidenceGap(`Missing dynamic checker runtime tree: ${runtime.path}`);
            runtimeTrees.push({ path: runtime.path, gitTree: record[2] });
          }
          const profile = reviewedHostSourceProfile(contract, { jobs: actualJobs, dependencies, runtimeTrees });
          if (!profile) throw new NativeEvidenceGap("Unreviewed protected job/checker/runtime source profile.");
          validation = { headSha: run.head_sha, lockGitBlob: lock.blob, jobs: actualJobs,
            dependencies, runtimeTrees, reviewedSourceRevision: profile.sourceRevision };
        } catch (error) {
          if (!(error instanceof NativeEvidenceGap)) throw error;
          reason = error.message;
        }
        sources.set(sourceKey, { validation, reason });
      }
      const source = sources.get(sourceKey);
      let jobs = null, jobError = null;
      try { jobs = request(`repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100`, normalizedJobs); }
      catch (error) {
        if (!/HTTP 404/.test(String(error.stderr))) throw error;
        jobError = "Initial-attempt host jobs are no longer available (HTTP 404).";
      }
      for (const gate of contract.gates) {
        let result = jobs ? hostGateObservation(contract, gate, jobs) : { passed: null, reason: jobError };
        if (gate.experiment && source.validation && verifiedHostStep(result.receipt, contract.until)) {
          const policy = gate.experiment;
          const endpoint = `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/logs`;
          const key = censusDigest([endpoint, policy, contract.conditionOracleSha256,
            ...(contract.conditionJobOracleSha256 ? [contract.conditionJobOracleSha256] : [])]), file = path.join(apiCache, `${key}.json`);
          let experiment;
          if (existsSync(file)) experiment = JSON.parse(readFileSync(file, "utf8"));
          else {
            try {
              const selectors = jobs.jobs.filter(job => job.name === contract.jobs[policy.job].name)
                .flatMap(job => job.steps.filter(step => step.name === policy.step).map(step => ({ job, step })));
              if (selectors.length !== 1 || !positive(selectors[0].job.id) || !verifiedHostStep(selectors[0].step, contract.until)) {
                throw new NativeEvidenceGap("No unique successful initial-attempt protected experiment selector.");
              }
              if (++requests > 1600) throw new Error("Native host API budget exhausted");
              let archive;
              try {
                archive = execFileSync("gh", ["api", endpoint], { maxBuffer: 32 * 1024 * 1024, timeout: 60000,
                  env: { ...process.env, GH_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
              } catch (error) {
                if (/HTTP (?:403|404|410)/.test(String(error.stderr))) throw new NativeEvidenceGap("Protected experiment logs are unavailable or access is denied.");
                if (error.code === "ENOBUFS" || error.signal === "SIGTERM") throw new NativeEvidenceGap("Protected experiment log download exceeds its execution/byte budget.");
                throw new Error(`Protected experiment log download failed (${String(error.stderr).match(/HTTP \d{3}/)?.[0] ?? error.code ?? error.status ?? "unknown error"}).`);
              }
              bytesRead += archive.length;
              if (bytesRead > 256 * 1024 * 1024) throw new Error("Native host API byte budget exhausted");
              const jobName = contract.jobs[policy.job].name;
              const { job, step } = selectors[0];
              let facts;
              if (contract.conditionJobOracleSha256) facts = readProtectedExperimentJobLog(archive, jobName, policy, step);
              else {
                const { text, ...receipt } = readProtectedHostLog(archive, policy.step, jobName);
                facts = { ...parseExperimentAssignmentLog(text, policy.name, step, policy.variants), ...receipt };
              }
              experiment = { status: "available", ...facts, jobName, jobId: job.id, selectorReceipt: step };
            } catch (error) {
              if (!(error instanceof NativeEvidenceGap) && !(error instanceof HostLogEvidenceGap)) throw error;
              experiment = { status: "unavailable", reason: error.message };
            }
            writeFileSync(file, JSON.stringify(experiment));
          }
          result = hostGateObservation(contract, gate, jobs, experiment);
        }
        const at = result.receipt?.completed_at && result.receipt.completed_at < contract.until
          ? result.receipt.completed_at : run.created_at;
        observations.push({ id: `${run.id}:1:${gate.job}:${gate.name}`, runId: run.id, attempt: 1,
          predicate: gate.meaning, at, observedAt: new Date().toISOString(),
          sourceValidation: source.validation, sourceGap: source.reason,
          receipt: result.receipt ?? null, passed: source.validation ? result.passed : null,
          missingReason: source.reason ?? result.reason });
      }
    }
    const partitions = [];
    for (let offset = 0; offset < observations.length; offset += 40) {
      const rows = observations.slice(offset, offset + 40);
      const file = `${contract.workflowId}-observations-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
      writeCensusJson(`${directory}/${file}`, rows);
      partitions.push({ file, count: rows.length, sha256: censusDigest(rows) });
    }
    const proven = observations.filter(row => row.passed === true).length;
    const index = { schemaVersion: 1, complete: true, repository: contract.repository,
      repositoryId: contract.repositoryId, workflowId: contract.workflowId,
      sourceRevision: contract.sourceRevision, until: contract.until, contractSha256: censusDigest(contract),
      inventoryRuns: inventory.size, observations: observations.length, proven, partitions,
      acquiredAt: new Date().toISOString(), rerunPolicy: "Only initial attempts; later artifact reuse cannot create duplicate native proof.",
      producer: { path: "scripts/collect-host-assertion-evidence.mjs",
        sha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") } };
    writeCensusJson(indexPath, index);
    const row = { workflowId: contract.workflowId, runs: inventory.size, observations: observations.length, proven,
      gaps: [...new Set(observations.map(row => row.missingReason).filter(Boolean))] };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  return results;
}

if (process.argv[1] === import.meta.filename) {
  if (!process.argv[2] || !process.argv[3] || process.argv.length !== 4) {
    throw new Error("usage: collect-host-assertion-evidence.mjs BARE_GIT_CACHE API_CACHE");
  }
  collectHostAssertionEvidence(process.argv[2], process.argv[3]);
}
