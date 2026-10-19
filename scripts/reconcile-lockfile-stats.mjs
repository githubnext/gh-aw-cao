import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { downloadLockfileArtifact, lockfileStatsDirectory as directory } from "./collect-lockfile-stats-evidence.mjs";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { writeLockfileInputs } from "./lockfile-stats-inputs.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (cache, args, options = {}) => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  timeout: 180000, maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
});
const text = (cache, args) => git(cache, args).toString("utf8").trimEnd();
const unzip = (file, args) => execFileSync("unzip", [...args, file], {
  timeout: 60000, maxBuffer: 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});

export function nativeStatisticalFacts(facts, population = []) {
  const parsed = population.filter(row => row.status === "parsed");
  const count = parsed.length;
  const mapped = { ...facts,
    skipped_malformed: facts.skipped_count, avg_size: facts.avg_bytes, min_size: facts.min_bytes, max_size: facts.max_bytes,
    cron_frequencies: facts.schedule_cron_frequencies, union_any_write_count: facts.workflows_with_any_write,
    mcp_servers: facts.mcp_server_usage, mcp_tools: facts.mcp_tool_usage, mcp_fallback_used_count: facts.mcp_fallback_count,
  };
  for (const [alias, source, total, max] of [
    ["job_counts_summary", "job_counts", "total_jobs", "max_jobs"],
    ["step_counts_summary", "step_counts", "total_steps", "max_steps"],
  ]) {
    mapped[alias] = { avg: count ? facts[source]?.[total] / count : undefined, max: facts[source]?.[max] };
  }
  if (!count) return mapped;
  const classic = ["actions", "attestations", "checks", "contents", "deployments", "discussions",
    "id-token", "issues", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses"];
  const effective = key => {
    const rows = parsed.map(row => row[key]);
    if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || Object.hasOwn(row, "*"))) return null;
    const scopes = new Set([...classic, ...rows.flatMap(row => Object.keys(row))]);
    return Object.fromEntries([...scopes].map(scope => {
      const values = { read: 0, write: 0, none: 0 };
      for (const row of rows) values[row[scope] ?? "none"]++;
      return [scope, values];
    }));
  };
  mapped.permissions_by_scope = effective("agent_job_permissions");
  mapped.agent_job_permissions_by_scope = mapped.permissions_by_scope;
  mapped.union_job_permissions_by_scope = effective("union_job_permissions");
  return mapped;
}

export function reconcileStatisticalClaims(summary, rawExpected, population = []) {
  const expected = nativeStatisticalFacts(rawExpected, population);
  const claims = [], unsupported = [];
  const incompleteSafeOutputs = expected?.safe_outputs_config_invalid > 0 || expected?.safe_outputs_config_missing > 0;
  const unavailable = incompleteSafeOutputs ? new Set(["safe_output_types", "discussion_categories",
    "create_discussion_workflows", "discussion_category_detected", "discussion_category_unresolved"]) : new Set();
  const visit = (actual, native, fields) => {
    if (actual && typeof actual === "object" && !Array.isArray(actual)) {
      for (const [key, value] of Object.entries(actual)) visit(value, native?.[key], [...fields, key]);
    } else if (typeof actual === "number" && Number.isFinite(actual)) {
      if (fields[0] === "script_counts_summary") unsupported.push({ field: fields.join("."), value: actual,
        reason: "This retained schema counts run steps plus actions/github-script; the frozen native facet counts run-script steps only. Different grains are not inaccurate counts." });
      else if (unavailable.has(fields[0])) unsupported.push({ field: fields.join("."), value: actual,
        reason: "At least one complete-population safe-output configuration is unresolved; partial subtotals cannot prove this exact aggregate." });
      else if (typeof native !== "number" || !Number.isFinite(native)) unsupported.push({ field: fields.join("."), value: actual });
      else {
        const integer = Number.isInteger(native);
        const decimalPlaces = String(actual).split(".")[1]?.length ?? 0;
        const agrees = integer ? actual === native : Math.abs(actual - native) < 0.5 * 10 ** -decimalPlaces;
        const aliases = { skipped_malformed: "skipped_count", avg_size: "avg_bytes", min_size: "min_bytes",
          max_size: "max_bytes", cron_frequencies: "schedule_cron_frequencies",
          agent_job_permissions_by_scope: "permissions_by_scope", union_any_write_count: "workflows_with_any_write",
          mcp_servers: "mcp_server_usage", mcp_tools: "mcp_tool_usage", mcp_fallback_used_count: "mcp_fallback_count" };
        let meaning = [aliases[fields[0]] ?? fields[0], ...fields.slice(1)].join(".");
        if (meaning === "workflow_dispatch_count") meaning = "trigger_counts.workflow_dispatch";
        if (meaning === "safe_output_types.create_discussion") meaning = "create_discussion_workflows";
        if (meaning === "engine_distribution.unknown") meaning = "engine_unknown";
        claims.push({ field: fields.join("."), meaning, actual, expected: native, agrees });
      }

    }
  };
  visit(summary, expected, []);
  return { claims, unsupported };
}

export function refreshRetainedLockfileClaims() {
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  for (const run of inventory) {
    const file = `${directory}/observations/${run.id}.json.gz`;
    if (!existsSync(file)) continue;
    const row = readCensusJson(file);
    const native = readCensusJson(`${directory}/${row.nativeInput}`);
    const bytes = Buffer.from(row.originalSummary.content, "base64");
    if (sha256(bytes) !== row.originalSummary.sha256) throw new Error("Original summary changed before availability correction");
    Object.assign(row, reconcileStatisticalClaims(JSON.parse(bytes), native.facts, native.population));
    writeCensusJson(file, row);
  }
}

export function reconciledFactCounts(claims) {
  const facts = new Map();
  for (const claim of claims) {
    const meaning = claim.meaning ?? claim.field;
    facts.set(meaning, (facts.get(meaning) ?? true) && claim.agrees);
  }
  return { verified: [...facts.values()].filter(Boolean).length,
    incorrect: [...facts.values()].filter(agrees => !agrees).length };
}

export function protectedAgentLog(jobs, entries, compiled) {
  const name = compiled.jobs?.agent?.name ?? "agent";
  if (typeof name !== "string" || name.includes("${{")) throw new Error("Unresolved compiled agent job name");
  const agents = jobs.jobs.filter(job => job.name === name);
  const logs = entries.filter(entry => /^\d+_/.test(entry) && entry.replace(/^\d+_/, "") === `${name}.txt`);
  if (agents.length !== 1 || logs.length !== 1) throw new Error("No unique source-defined agent protected log");
  return { job: agents[0], entry: logs[0] };
}

export function checkoutReceipt(log, step, expectedSha) {
  const start = Date.parse(step?.started_at), end = Date.parse(step?.completed_at);
  if (step?.status !== "completed" || step?.conclusion !== "success"
    || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const lines = log.split(/\r?\n/).filter(line => {
    const at = Date.parse(line.slice(0, line.indexOf(" ")));
    return at >= start && at < end + 1000;
  });
  const matches = lines.map(line => line.match(/^\d{4}-\d\d-\d\dT\S+ ([a-f0-9]{40})$/)).filter(Boolean);
  if (!matches.length || matches.some(match => match[1] !== expectedSha)) return null;
  const excerpt = lines.filter(line => /^[^ ]+ (?:[a-f0-9]{40}|\[command\].*git log -1 --format=%H)$/.test(line)).join("\n");
  if (!excerpt.includes("git log -1 --format=%H")) return null;
  return { checkoutSha: expectedSha, step, excerpt, sha256: sha256(excerpt) };
}

function censusAt(cache, commit, python) {
  const file = `${directory}/inputs/${commit}.json.gz`;
  if (existsSync(file)) return readCensusJson(file);
  const entries = text(cache, ["ls-tree", "-r", commit, "--", ".github/workflows"]).split("\n").flatMap(line => {
    const match = line.match(/^100644 blob ([a-f0-9]{40})\t(\.github\/workflows\/[^/]+\.lock\.yml)$/);
    return match ? [{ path: match[2], gitBlob: match[1] }] : [];
  });
  const allEntries = text(cache, ["ls-tree", "-r", commit, "--", ".github/workflows"]).split("\n")
    .filter(line => /\.github\/workflows\/[^/]+\.lock\.yml$/.test(line));
  if (entries.length !== allEntries.length || !entries.length) throw new Error("Unsupported or empty full lockfile population");
  const ids = [...new Set(entries.map(row => row.gitBlob))];
  const checks = git(cache, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: ids.join("\n") + "\n", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).toString("utf8").trim().split("\n");
  const missing = checks.filter(row => row.endsWith(" missing")).map(row => row.split(" ")[0]);
  if (missing.length) git(cache, ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "--stdin", "origin"],
    { input: missing.join("\n") + "\n" });
  const files = entries.map(row => ({ ...row, content: git(cache, ["cat-file", "blob", row.gitBlob]).toString("base64") }));
  const native = JSON.parse(execFileSync(python, ["scripts/native-lockfile-stats.py"], {
    input: JSON.stringify(files), timeout: 300000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }));
  mkdirSync(path.dirname(file), { recursive: true });
  const inputBlobs = writeLockfileInputs(`${directory}/inputs`, commit, files);
  const result = { commit, inputPopulationDigest: censusDigest(entries), inputBlobs,
    oracleSha256: sha256(readFileSync("scripts/native-lockfile-stats.py")), ...native };
  writeCensusJson(file, result);
  return result;
}

export function reconcileLockfileStats(cache, apiCache, python) {
  const offline = process.env.LOCKFILE_STATS_OFFLINE === "1";
  const contract = readCensusJson(`${directory}/contract.json`);
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  const inventoryIndex = readCensusJson(`${directory}/inventory-index.json`);
  if (!inventoryIndex.complete || inventoryIndex.inventorySha256 !== censusDigest(inventory)
    || inventoryIndex.contractSha256 !== censusDigest(contract)) throw new Error("Frozen inventory changed");
  const reader = publicGitSourceReader(cache, contract.repository);
  const read = (commit, file) => {
    const entry = text(cache, ["ls-tree", "-r", commit, "--", file]);
    if (entry) {
      const id = entry.split(/\s+/)[2];
      // The Git transport batches immutable public objects without spending REST quota.
      git(cache, ["cat-file", "blob", id]);
    }
    return reader.read(commit, file);
  };
  const source = read(contract.sourceRevision, ".github/workflows/lockfile-stats.md");
  if (source.id !== contract.sourceGitBlob) throw new Error("Workflow source changed");
  const body = source.bytes.toString("utf8").split("\n---\n").slice(1).join("\n---\n");
  const requiredImports = ["shared/daily-audit-base.md", "shared/daily-audit-discussion.md", "shared/reporting.md", "shared/otlp.md"];
  const sources = requiredImports.map(file => read(contract.sourceRevision, `.github/workflows/${file}`));
  sources.push(source, read(contract.sourceRevision, ".github/workflows/lockfile-stats.lock.yml"));
  const profiles = [], observations = [];
  mkdirSync(`${directory}/observations`, { recursive: true });
  for (const run of inventory) {
    const rowFile = `${directory}/observations/${run.id}.json.gz`;
    if (existsSync(rowFile)) {
      const row = readCensusJson(rowFile);
      read(run.head_sha, ".github/workflows/lockfile-stats.md");
      read(run.head_sha, ".github/workflows/lockfile-stats.lock.yml");
      profiles.push({ runId: run.id, headSha: run.head_sha, sourceGitBlob: row.sourceGitBlob,
        bodySha256: row.sourceBodySha256, compatible: true });
      observations.push(row); continue;
    }
    const row = { id: run.id, at: run.created_at, headSha: run.head_sha, status: "missing",
      reason: "No surviving source-bound initial-attempt summary.", claims: [], unsupported: [] };
    const cacheArtifact = run.artifacts.find(item => item.name === "cache-memory" && !item.expired);
    if (!cacheArtifact) { observations.push(row); continue; }
    if (run.run_attempt !== 1 || run.headRepositoryId !== contract.repositoryId
      || !["schedule", "workflow_dispatch"].includes(run.event) || run.head_branch !== "main") {
      row.reason = "No unambiguous same-repository initial default-branch execution.";
      observations.push(row); continue;
    }
    const actualSource = read(run.head_sha, ".github/workflows/lockfile-stats.md");
    if (!actualSource) throw new Error("Run workflow source is absent");
    const actualBody = actualSource.bytes.toString("utf8").split("\n---\n").slice(1).join("\n---\n");
    profiles.push({ runId: run.id, headSha: run.head_sha, sourceGitBlob: actualSource.id, bodySha256: sha256(actualBody), compatible: actualBody === body });
    if (actualBody !== body) {
      row.reason = "Historical prompt has a different measurement/acceptance profile; retained but not relabeled as V4.";
      observations.push(row); continue;
    }
    if (offline && !existsSync(path.join(apiCache, `${cacheArtifact.id}.zip`))) {
      row.reason = "Surviving artifact not yet downloaded; REST acquisition paused at shared quota exhaustion.";
      observations.push(row); continue;
    }
    const downloaded = downloadLockfileArtifact(cacheArtifact, apiCache);
    const names = unzip(downloaded.file, ["-Z1"]).trim().split("\n");
    const name = `history/${run.created_at.slice(0, 10)}.json`;
    if (!names.includes(name)) { row.reason = "Cache artifact lacks a same-day original summary."; observations.push(row); continue; }
    const raw = execFileSync("unzip", ["-p", downloaded.file, name], { maxBuffer: 1024 * 1024 });
    const summary = JSON.parse(raw);
    const jobsFile = path.join(apiCache, `${run.id}-jobs.json`);
    if (offline && !existsSync(jobsFile)) {
      row.reason = "Protected jobs receipt not yet downloaded; REST acquisition paused at shared quota exhaustion.";
      observations.push(row); continue;
    }
    if (!existsSync(jobsFile)) writeFile(jobsFile, `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
    const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));
    if (jobs.total_count !== jobs.jobs?.length) throw new Error("Incomplete protected job receipt");
    const lock = read(run.head_sha, ".github/workflows/lockfile-stats.lock.yml");
    const logFile = path.join(apiCache, `${run.id}-logs.zip`);
    if (offline && !existsSync(logFile)) {
      row.reason = "Protected checkout log not yet downloaded; REST acquisition paused at shared quota exhaustion.";
      observations.push(row); continue;
    }
    if (!existsSync(logFile)) writeFile(logFile, `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/logs`, false);
    const logEntries = unzip(logFile, ["-Z1"]).trim().split("\n");
    const compiled = parse(lock.bytes.toString("utf8"));
    const { job, entry: agentEntry } = protectedAgentLog(jobs, logEntries, compiled);
    const sourceCheckouts = compiled.jobs?.agent?.steps?.filter(step =>
      ["Checkout repository", "Checkout repository (gh-aw default)"].includes(step.name)
      && /^actions\/checkout@[a-f0-9]{40}$/.test(step.uses)
      && !step.with?.ref && !step.with?.repository);
    const checkout = job.steps.filter(step => sourceCheckouts?.length === 1 && step.name === sourceCheckouts[0].name);
    const uploads = job.steps.filter(step => step.name === "Upload cache-memory data as artifact");
    const logs = execFileSync("unzip", ["-p", logFile, agentEntry], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
    const receipt = checkout.length === 1 ? checkoutReceipt(logs, checkout[0], run.head_sha) : null;
    const upload = uploads[0];
    if (!receipt || uploads.length !== 1 || upload.conclusion !== "success" || upload.status !== "completed"
      || cacheArtifact.workflow_run?.id !== run.id || cacheArtifact.workflow_run.head_sha !== run.head_sha) {
      row.reason = "No exact protected checkout/upload/input binding.";
      observations.push(row); continue;
    }
    const native = censusAt(cache, run.head_sha, python);
    const comparison = reconcileStatisticalClaims(summary, native.facts, native.population);
    const result = { ...row, status: "assessed", reason: null, ...comparison,
      sourceGitBlob: actualSource.id, lockGitBlob: lock.id,
      sourceBodySha256: sha256(body), inputPopulationDigest: native.inputPopulationDigest,
      eligibleLockfiles: native.population.length, nativeInput: `inputs/${run.head_sha}.json.gz`,
      nativeInputSha256: censusDigest(native), parser: native.parser,
      originalSummary: { name, sha256: sha256(raw), content: raw.toString("base64") },
      receipt: { artifact: cacheArtifact, archiveSha256: downloaded.sha256,
        logArchiveSha256: sha256(readFileSync(logFile)), checkout: receipt, upload, jobId: job.id },
      generatedAt: summary.generated_at ?? null,
      gates: { summaryWithin50KB: raw.length <= 50 * 1024, yamlAvailable: summary.yaml_available === true,
        nativePopulationComplete: true, budget: "not-measured", insights: "not-measured", publication: "not-measured" } };
    writeCensusJson(rowFile, result);
    observations.push(result);
    console.error(`${run.id}: reconciled ${result.claims.filter(item => item.agrees).length}/${result.claims.length} facts over ${result.eligibleLockfiles} lockfiles`);
  }
  const baseline = censusAt(cache, contract.adoption.baselineCommit, python);
  const retainedSources = reader.sources();
  const sourceParts = [];
  for (let start = 0; start < retainedSources.length; start += 10) {
    const values = retainedSources.slice(start, start + 10);
    const file = `sources-${String(sourceParts.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(`${directory}/${file}`, values);
    sourceParts.push({ file, count: values.length, sha256: censusDigest(values) });
  }
  writeCensusJson(`${directory}/sources-index.json`, { complete: true, count: retainedSources.length, parts: sourceParts });
  writeCensusJson(`${directory}/source-profiles.json`, profiles);
  writeCensusJson(`${directory}/assessments.json.gz`, observations);
  const index = { complete: true, contractSha256: censusDigest(contract), inventorySha256: censusDigest(inventory),
    assessmentsSha256: censusDigest(observations), observations: observations.length,
    eligibleRuns: inventory.filter(run => ["schedule", "workflow_dispatch"].includes(run.event)).length,
    ineligibleRuns: inventory.filter(run => !["schedule", "workflow_dispatch"].includes(run.event)).length,
    acquisitionComplete: !observations.some(row => row.reason?.includes("REST acquisition paused")),
    pendingRetainedAcquisitions: observations.filter(row => row.reason?.includes("REST acquisition paused")).length,
    assessed: observations.filter(row => row.status === "assessed").length,
    verifiedFacts: observations.reduce((sum, row) => sum + reconciledFactCounts(row.claims).verified, 0),
    incorrectFacts: observations.reduce((sum, row) => sum + reconciledFactCounts(row.claims).incorrect, 0),
    baselineProbe: { commit: baseline.commit, lockfiles: baseline.population.length,
      nativeInputSha256: censusDigest(baseline), deliveredReport: null,
      reason: "Immutable Git reconstructs the census input but cannot establish a pre-adoption delivered assertion." } };
  writeCensusJson(`${directory}/index.json`, index);
  const pending = observations.filter(row => row.reason?.includes("REST acquisition paused")).map(row => {
    const run = inventory.find(run => run.id === row.id);
    const artifact = run.artifacts.find(item => item.name === "cache-memory" && !item.expired);
    const endpoints = [];
    if (!existsSync(path.join(apiCache, `${artifact.id}.zip`))) endpoints.push(`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`);
    if (!existsSync(path.join(apiCache, `${run.id}-jobs.json`))) endpoints.push(`repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
    if (!existsSync(path.join(apiCache, `${run.id}-logs.zip`))) endpoints.push(`repos/github/gh-aw/actions/runs/${run.id}/attempts/1/logs`);
    return { runId: run.id, at: run.created_at, artifactId: artifact.id, reason: row.reason, endpoints };
  });
  writeCensusJson(`${directory}/resume.json`, { schemaVersion: 1, repository: contract.repository,
    until: contract.until, contractSha256: censusDigest(contract),
    status: pending.length ? "paused-shared-github-core-quota" : "acquisition-complete",
    pending, command: "node scripts/reconcile-lockfile-stats.mjs BARE_SOURCE_CACHE API_CACHE PYTHON_WITH_PYYAML_6_0_3",
    offlineCommand: "LOCKFILE_STATS_OFFLINE=1 node scripts/reconcile-lockfile-stats.mjs BARE_SOURCE_CACHE API_CACHE PYTHON_WITH_PYYAML_6_0_3",
    note: "Reuse acquired cache files; do not repeat exhaustive discovery. Missing snapshots remain null and are not evidence of zero value." });
  return index;
}

function writeFile(file, endpoint, json = true) {
  const bytes = execFileSync("gh", ["api", endpoint], { timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
  if (json) JSON.parse(bytes);
  // Native acquisition bytes are cached separately from accepted evidence.
  writeFileSync(file, bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(reconcileLockfileStats(process.argv[2], process.argv[3], process.argv[4])));
}
