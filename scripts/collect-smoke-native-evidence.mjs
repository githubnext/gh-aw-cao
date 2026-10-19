import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { smokeCases, smokeDigest, smokeRead } from "./native-smoke-value.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export function smokeAttemptUrl(run, repository, attempt) {
  const url = new URL(run.html_url);
  if (!positive(run.id) || !positive(attempt) || attempt > 20 || url.protocol !== "https:"
    || url.pathname !== `/${repository}/actions/runs/${run.id}`
    || url.username || url.password || url.search || url.hash) throw new Error("Invalid immutable smoke execution URL");
  return `${url.href}/attempts/${attempt}`;
}
export function smokeHostSuccess(step) {
  return step?.status === "completed" && step.conclusion === "success"
    && Number.isFinite(Date.parse(step.started_at)) && Number.isFinite(Date.parse(step.completed_at))
    && step.completed_at >= step.started_at;
}
export function smokeBehaviorProofs(workflowId, gates, coreReport = null) {
  const cases = smokeCases[workflowId].map(name => ({ name, passed: null }));
  const prove = names => { for (const name of names) cases.find(item => item.name === name).passed = true; };
  let fullAcceptance = null;
  if (workflowId === "smoke-agy") {
    const core = smokeHostSuccess(gates["Assert engine conformance"]);
    const native = smokeHostSuccess(gates["Assert native Agy MCP transport and inference accounting"]);
    if (core) prove(smokeCases[workflowId].slice(0, 6));
    else if (coreReport) {
      if (coreReport.engine !== "agy" || !Array.isArray(coreReport.checks)
        || new Set(coreReport.checks.map(item => item.name)).size !== coreReport.checks.length
        || !["passed", "failed"].includes(coreReport.status)
        || coreReport.checks.some(item => !["passed", "failed"].includes(item.status))
        || !["fixtures", "agent-execution", ...smokeCases[workflowId].slice(0, 6)]
          .every(name => coreReport.checks.some(item => item.name === name))
        || (coreReport.status === "passed") !== coreReport.checks.every(item => item.status === "passed")) {
        throw new Error("Malformed protected Agy host report");
      }
      if (coreReport.checks.find(item => item.name === "fixtures").status === "passed") {
        for (const item of cases.slice(0, 6)) item.passed = coreReport.checks.find(check => check.name === item.name).status === "passed";
      }
    }
    if (native) prove(smokeCases[workflowId].slice(6));
    if (core && native) fullAcceptance = true;
  } else if (workflowId === "smoke-aider") {
    if (smokeHostSuccess(gates["Verify Aider smoke test evidence"])) prove(smokeCases[workflowId]);
  } else if (workflowId === "smoke-claude-copilot") {
    if (smokeHostSuccess(gates["Assert Claude Copilot inference evidence"])) {
      prove(smokeCases[workflowId]);
      fullAcceptance = true;
    }
  } else throw new Error("Unknown smoke workflow");
  return { cases, fullAcceptance };
}
export function verifySmokeEnvironment(locked, contract) {
  const job = locked?.jobs?.agent;
  if (!job || job.container || job["continue-on-error"] || job["runs-on"] !== "ubuntu-latest"
    || !Array.isArray(job.steps)) throw new Error("Untrusted host job environment");
  for (const required of contract.protectedSteps) {
    const matches = job.steps.filter(step => step.name === required.name);
    if (matches.length !== 1 || smokeDigest(matches[0]) !== required.sha256 || matches[0]["continue-on-error"]) {
      throw new Error(`Missing exact frozen host checker/environment: ${required.name}`);
    }
  }
  const checkout = job.steps.find(step => step.name === "Checkout actions folder");
  if (checkout?.with?.repository !== contract.repository || checkout.with.ref
    || checkout.with["sparse-checkout"]?.trim() !== "actions") throw new Error("Unexpected host runtime checkout");
  return job;
}
export async function collectSmokeEvidence(contractsFile, cache) {
  mkdirSync(cache, { recursive: true });
  const gitDir = path.join(cache, "repository.git");
  const git = args => execFileSync("git", ["--git-dir", gitDir, ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  const contracts = smokeRead(contractsFile);
  const root = path.dirname(contractsFile);
  const outputs = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
  if (outputs.index.repository !== "github/gh-aw" || outputs.index.until !== contracts[0].until
    || outputs.index.complete !== true) throw new Error("Shared output history is incomplete or outside the frozen smoke scope");
  let requests = 0, downloadedBytes = 0;
  const request = (endpoint, binary = false) => {
    const file = path.join(cache, `${hash(endpoint)}.${binary ? "zip" : "json"}`);
    if (existsSync(file)) return binary ? readFileSync(file) : JSON.parse(readFileSync(file, "utf8"));
    if (++requests > 1200) throw new Error("Smoke API request budget exhausted");
    const bytes = execFileSync("gh", ["api", endpoint], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
      timeout: 60000, env: { ...process.env, GH_PAGER: "cat" } });
    downloadedBytes += bytes.length;
    if (downloadedBytes > 512 * 1024 * 1024) throw new Error("Smoke acquisition byte budget exhausted");
    writeFileSync(file, bytes);
    return binary ? bytes : JSON.parse(bytes);
  };
  const repository = request("repos/github/gh-aw");
  if (repository.id !== 1036865607 || repository.full_name !== "github/gh-aw") throw new Error("Wrong frozen repository identity");
  const until = contracts[0].sourceRevision;
  const runtimeTrees = new Map();
  for (const commit of git(["log", "--first-parent", "--format=%H", until, "--", "actions"]).split("\n")) {
    try { runtimeTrees.set(git(["rev-parse", `${commit}:actions`]), commit); } catch { /* Actions directory predates this measurement. */ }
  }
  const summary = [];
  for (const contract of contracts) {
    const { workflowId } = contract;
    const execution = `.github/workflows/${workflowId}.lock.yml`;
    const knownLocks = new Map();
    for (const commit of git(["log", "--first-parent", "--format=%H", until, "--", execution]).split("\n")) {
      try { knownLocks.set(git(["rev-parse", `${commit}:${execution}`]), commit); } catch { /* Deleted workflow revisions are not candidate locks. */ }
    }
    const inventory = new Map();
    let total = null, complete = false;
    for (let page = 1; page <= 10; page++) {
      const response = request(`repos/github/gh-aw/actions/workflows/${workflowId}.lock.yml/runs?created=${encodeURIComponent(`${contract.adoption.adoptedAt}..${contract.until}`)}&per_page=100&page=${page}`);
      if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count) || response.total_count > 1000) {
        throw new Error("Over-budget or invalid smoke inventory");
      }
      total = response.total_count;
      for (const run of response.workflow_runs) {
        if (!positive(run.id) || !positive(run.run_attempt) || run.run_attempt > 20 || !sha(run.head_sha)
          || run.path.split("@")[0] !== execution || run.head_repository?.id !== 1036865607
          || inventory.has(run.id)) throw new Error("Invalid/duplicate smoke run identity");
        inventory.set(run.id, run);
      }
      if (inventory.size === total) { complete = true; break; }
      if (!response.workflow_runs.length) throw new Error("Incomplete smoke run traversal");
    }
    if (!complete) throw new Error("Incomplete smoke inventory");
    const candidates = outputs.entities.filter(row => row.workflowReference?.workflowId === workflowId || row.unverifiedWorkflowId === workflowId);
    const candidateFiles = [];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const rows = candidates.slice(offset, offset + 100);
      const file = `${workflowId}-output-candidates-${String(candidateFiles.length + 1).padStart(3, "0")}.json.gz`;
      const bytes = gzipSync(JSON.stringify(rows));
      if (bytes.length > 256 * 1024) throw new Error("Oversized smoke candidate partition");
      writeFileSync(path.join(root, file), bytes);
      candidateFiles.push({ file, sha256: smokeDigest(rows), rows: rows.length });
    }
    const missingCandidateRuns = [...new Set(candidates.map(row => row.workflowReference?.runId).filter(Boolean))]
      .filter(id => !inventory.has(Number(id)));
    const candidateRunGaps = [];
    for (const id of missingCandidateRuns) {
      try {
        const run = request(`repos/github/gh-aw/actions/runs/${id}`);
        candidateRunGaps.push({ id, path: run.path, createdAt: run.created_at, reason: "Output footer is a discovery candidate, not host behavioral evidence." });
      } catch (error) { candidateRunGaps.push({ id, reason: String(error.stderr || error.message).slice(0, 300) }); }
    }
    const observations = [];
    for (const run of inventory.values()) {
      if (run.created_at >= contract.until) continue;
      let environment = null, sourceError = null;
      try {
        if (run.event.startsWith("pull_request")) throw new Error("PR merge-ref checkout cannot be bound to the API head SHA without an independent retained checkout receipt");
        try { git(["cat-file", "-e", run.head_sha]); } catch { git(["fetch", "--quiet", "origin", run.head_sha]); }
        const lockBlob = git(["rev-parse", `${run.head_sha}:${execution}`]);
        const actionsTree = git(["rev-parse", `${run.head_sha}:actions`]);
        if (!knownLocks.has(lockBlob)) throw new Error("Execution lock is not a reviewed frozen mainline blob");
        if (!runtimeTrees.has(actionsTree)) throw new Error("Execution host actions tree is not a reviewed frozen mainline tree");
        const protectedImports = contract.protectedImports.map(item => {
          const blob = git(["rev-parse", `${run.head_sha}:${item.path}`]);
          if (!item.acceptedGitBlobs.includes(blob)) throw new Error(`Unreviewed host receipt/telemetry producer: ${item.path}`);
          return { path: item.path, gitBlob: blob };
        });
        const job = verifySmokeEnvironment(parse(git(["show", `${run.head_sha}:${execution}`])), contract);
        environment = { headSha: run.head_sha, headBranch: run.head_branch,
          commonAncestor: git(["merge-base", run.head_sha, contract.sourceRevision]),
          lockGitBlob: lockBlob, trustedLockCommit: knownLocks.get(lockBlob),
          actionsTree, trustedActionsCommit: runtimeTrees.get(actionsTree),
          jobSha256: smokeDigest(job), protectedSteps: contract.protectedSteps, protectedImports };
      } catch (error) { sourceError = String(error.stderr || error.message).slice(0, 400); }
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const row = { id: `${run.id}:${attempt}`, runId: run.id, attempt, at: run.created_at,
          headSha: run.head_sha, headBranch: run.head_branch, event: run.event,
          runUrl: smokeAttemptUrl(run, contract.repository, attempt),
          observedAt: new Date().toISOString(), sourceValidation: environment,
          gates: {}, missing: [], cases: smokeCases[workflowId].map(name => ({ name, passed: null })), fullAcceptance: null };
        try {
          if (sourceError) throw new Error(sourceError);
          const response = request(`repos/github/gh-aw/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
          if (!Array.isArray(response.jobs) || response.total_count > response.jobs.length) throw new Error("Incomplete host job inventory");
          row.jobsResponseSha256 = smokeDigest(response);
          for (const expected of contract.protectedSteps.filter(item => !item.name.startsWith("Prepare "))) {
            const matches = response.jobs.flatMap(job => (job.steps ?? []).filter(step => step.name === expected.name)
              .map(step => ({ job, step })));
            if (matches.length !== 1) { row.missing.push(`No unique host step: ${expected.name}`); continue; }
            const { job, step } = matches[0];
            if (!step.completed_at || step.completed_at >= contract.until) {
              row.missing.push(`Host evidence unavailable before cutoff: ${expected.name}`); continue;
            }
            row.at = row.at > step.completed_at ? row.at : step.completed_at;
            row.gates[expected.name] = { jobId: job.id, number: step.number, status: step.status,
              conclusion: step.conclusion, started_at: step.started_at, completed_at: step.completed_at };
            if (!smokeHostSuccess(step)) row.missing.push(`Failed/skipped host conjunction has no inferred failed constituent cases: ${expected.name}`);
          }
          Object.assign(row, smokeBehaviorProofs(workflowId, row.gates));
          if (workflowId === "smoke-agy" && !smokeHostSuccess(row.gates["Assert engine conformance"])) {
            try {
              const artifacts = request(`repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100`);
              if (!Array.isArray(artifacts.artifacts) || artifacts.total_count > artifacts.artifacts.length) throw new Error("Incomplete artifact inventory");
              row.artifactInventory = artifacts.artifacts.map(item => ({ id: item.id, name: item.name, expired: item.expired,
                createdAt: item.created_at, size: item.size_in_bytes, digest: item.digest }));
              const gate = row.gates["Assert engine conformance"];
              const candidates = artifacts.artifacts.filter(item => item.name === "engine-conformance-agy"
                && !item.expired && item.size_in_bytes <= 1024 * 1024 && gate?.completed_at
                && item.created_at >= gate.completed_at);
              if (run.run_attempt !== 1 || candidates.length !== 1) throw new Error("No retained unambiguous protected report artifact");
              const archive = request(`repos/github/gh-aw/actions/artifacts/${candidates[0].id}/zip`, true);
              if (candidates[0].digest && candidates[0].digest !== `sha256:${hash(archive)}`) throw new Error("Protected report digest mismatch");
              const archiveFile = path.join(cache, `${hash(archive)}.zip`);
              writeFileSync(archiveFile, archive);
              const entries = execFileSync("unzip", ["-Z1", archiveFile], { encoding: "utf8" }).trim();
              if (entries !== "report.json") throw new Error("Unexpected protected report archive");
              const text = execFileSync("unzip", ["-p", archiveFile, "report.json"], { encoding: "utf8", maxBuffer: 65536 });
              row.coreReport = JSON.parse(text);
              row.coreReport.checks = row.coreReport.checks.map(({ name, status }) => ({ name, status }));
              row.reportSha256 = hash(text);
              Object.assign(row, smokeBehaviorProofs(workflowId, row.gates, row.coreReport));
            } catch (error) { row.missing.push(String(error.message).slice(0, 250)); }
          }
        } catch (error) { row.missing.push(String(error.message).slice(0, 400)); }
        row.status = row.cases.some(item => item.passed !== null) ? "measured" : "evidence-blocked";
        observations.push(row);
      }
    }
    const partitions = [];
    for (let offset = 0; offset < observations.length; offset += 50) {
      const rows = observations.slice(offset, offset + 50), file = `${workflowId}-observations-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
      const bytes = gzipSync(JSON.stringify(rows));
      if (bytes.length > 256 * 1024) throw new Error("Oversized smoke partition");
      writeFileSync(path.join(root, file), bytes);
      partitions.push({ file, sha256: smokeDigest(rows), rows: rows.length });
    }
    const index = { schemaVersion: 1, repository: contract.repository, repositoryId: 1036865607,
      workflowId, sourceRevision: contract.sourceRevision, until: contract.until, complete,
      producer: { path: "scripts/collect-smoke-native-evidence.mjs", sha256: hash(readFileSync(import.meta.filename)) },
      contractSha256: smokeDigest(contract), inventoryRuns: inventory.size, observations: observations.length, partitions,
      outputHistory: { index: "../../gh-aw-workflows/evidence/history.json.gz",
        indexSha256: smokeDigest(outputs.index), totalEntities: outputs.entities.length,
        candidates: candidates.length, partitions: candidateFiles, candidateRunGaps,
        limitation: "Issue/PR bodies are editable discovery references. Their PASS claims and publishing/closure are not native behavioral proof." },
      acquisition: { runInventory: "All branch names, every retained attempt, created within true adoption and frozen cutoff.",
        trust: "Immutable execution lock and actions tree must independently match frozen first-parent mainline history; exact frozen checker/environment hashes required. Branch name alone neither grants nor denies evidence.",
        limitations: ["Actions API inventories cannot reconstruct deleted runs or expired logs/artifacts.",
          "Historical editions without the exact approved host checker remain missing, not behavioral failures.",
          "No upstream write, dispatch, deployment or fabricated test evidence was used."] } };
    writeFileSync(path.join(root, `${workflowId}-index.json`), `${JSON.stringify(index, null, 2)}\n`);
    summary.push({ workflowId, inventoryRuns: inventory.size, attempts: observations.length,
      measuredAssessments: observations.filter(row => row.status === "measured").length,
      provenBehaviors: observations.flatMap(row => row.cases).filter(item => item.passed === true).length,
      fullyAccepted: observations.filter(row => row.fullAcceptance === true).length,
      missingReasons: [...new Set(observations.flatMap(row => row.missing))] });
    console.error(JSON.stringify(summary.at(-1)));
  }
  return { summary, requests, downloadedBytes };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("usage: collect-smoke-native-evidence.mjs CONTRACTS.json PRIVATE_CACHE");
  console.log(JSON.stringify(await collectSmokeEvidence(process.argv[2], process.argv[3]), null, 2));
}
