import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { boundedPublicGitArchive } from "./bounded-public-git-archive.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { dynamicEvidenceDirectory as directory, dynamicWorkflowSlug as slug } from "./copilot-dynamic-workflow-value.mjs";

const repository = "github/gh-aw", repositoryId = 1036865607;
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
const adoption = {
  commit: "ffc93b2f3118eae982d395381bdcd81cf8e1fc67", adoptedAt: "2026-10-06T17:16:08Z",
  baselineCommit: "ea26db6a5beb68ae37d97613f3e9c7923d92d515", baselineAt: "2026-10-06T16:04:42Z",
};
const sourcePath = `.github/workflows/${slug}.md`, lockPath = sourcePath.replace(/\.md$/, ".lock.yml");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
class DynamicSourceGap extends Error {
  constructor(at, file, gitBlob) {
    super(`Missing offline immutable source: ${file}@${at}`);
    this.reference = { commit: at, path: file, gitBlob, endpoint: `repos/${repository}/git/blobs/${gitBlob}` };
  }
}

export function validateRunInventory(response, workflowPath) {
  if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0
    || !Array.isArray(response.workflow_runs) || response.total_count !== response.workflow_runs.length
    || new Set(response.workflow_runs.map(row => row?.id)).size !== response.workflow_runs.length
    || response.workflow_runs.some(row => !Number.isSafeInteger(row?.id) || row.id <= 0
      || !Number.isSafeInteger(row.run_attempt) || row.run_attempt <= 0
      || !/^[a-f0-9]{40}$/.test(row.head_sha) || row.path !== workflowPath
      || !Number.isFinite(Date.parse(row.created_at)))) throw new Error("Incomplete or malformed dynamic-workflow inventory");
  return response.workflow_runs;
}

export function classifyDynamicSelection(workflowPath, jobs) {
  if (workflowPath === lockPath) return "direct";
  if (jobs?.status !== "available") return "unknown-reusable-branch";
  const selected = jobs.value.jobs.filter(job => job.name === `call-${slug}`);
  if (selected.length === 1 && selected[0].status === "completed" && selected[0].conclusion === "skipped"
    && Number.isFinite(Date.parse(selected[0].completed_at)) && selected[0].completed_at < until) {
    return "protected-caller-skipped";
  }
  return "unknown-reusable-branch";
}

export function collectDynamicWorkflowValue(cache, apiCache) {
  mkdirSync(apiCache, { recursive: true });
  const archive = boundedPublicGitArchive(cache, repository, `${directory}/sources`);
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  const executableSources = [];
  const offline = process.env.CAO_DYNAMIC_OFFLINE === "1";
  const readSource = (file, at = revision) => {
    const record = git(["ls-tree", at, "--", file]);
    if (!record) return null;
    const gitBlob = record.split(/\s+/)[2];
    const retainedPath = `${directory}/sources/${gitBlob}.json.gz`;
    if (offline && existsSync(retainedPath)) {
      const retained = readCensusJson(retainedPath), bytes = Buffer.from(retained.content, "base64");
      verifyPublicGitBlob(bytes, gitBlob);
      if (digest(bytes) !== retained.sha256) throw new Error("Retained offline source digest mismatch");
      executableSources.push({ gitBlob, sha256: censusDigest(retained) });
      return { id: gitBlob, sha256: retained.sha256, bytes };
    }
    if (offline) {
      try {
        execFileSync("git", [`--git-dir=${cache}`, "cat-file", "-e", gitBlob], {
          timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        });
      } catch (error) {
        if (error.status !== 1 && error.status !== 128) throw error;
        throw new DynamicSourceGap(at, file, gitBlob);
      }
    }
    if (!record.startsWith("100755 blob ")) return archive.read(at, file);
    const bytes = execFileSync("git", [`--git-dir=${cache}`, "cat-file", "blob", gitBlob], {
      timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    verifyPublicGitBlob(bytes, gitBlob);
    const retained = { id: gitBlob, mode: "100755", sha256: digest(bytes), content: bytes.toString("base64") };
    writeCensusJson(`${directory}/sources/${gitBlob}.json.gz`, retained);
    executableSources.push({ gitBlob, sha256: censusDigest(retained) });
    return { id: gitBlob, sha256: retained.sha256, bytes };
  };
  let calls = 0;
  const request = (endpoint, normalize = value => value, binary = false) => {
    const key = endpoint.includes("/jobs?") ? `${endpoint}:job-timestamps-v2` : endpoint;
    const filename = path.join(apiCache, `${digest(key)}.json`);
    if (existsSync(filename)) return readCensusJson(filename);
    if (offline) throw new Error(`Unacquired endpoint while offline: ${endpoint}`);
    if (++calls > 600) throw new Error("Dynamic-workflow acquisition budget exhausted; inventory remains incomplete");
    let value;
    try {
      const bytes = execFileSync("gh", ["api", endpoint], {
        timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_PAGER: "cat" },
      });
      value = { status: "available", value: normalize(binary ? bytes : JSON.parse(bytes)), responseSha256: digest(bytes) };
    } catch (error) {
      const status = String(error.stderr).match(/HTTP (403|404|410)/)?.[1];
      if (!status) throw error;
      value = { status: "unavailable", httpStatus: Number(status), reason: `GitHub returned HTTP ${status}.` };
    }
    writeCensusJson(filename, value);
    return value;
  };
  const identity = request(`repos/${repository}`, row => ({ id: row.id, full_name: row.full_name }));
  if (identity.value?.id !== repositoryId || identity.value.full_name !== repository) throw new Error("Repository identity mismatch");
  const source = readSource(sourcePath);
  if (source.id !== "c9663c6985318c8e2d0dfa833f62ca06873541c7") throw new Error("Frozen intent blob changed");
  for (const file of [sourcePath, lockPath]) {
    if (git(["diff-tree", "--no-commit-id", "--name-status", "-r", adoption.baselineCommit, adoption.commit, "--", file])
      !== `A\t${file}`) throw new Error("Adoption is not a true source/lock addition");
  }
  const sources = [
    sourcePath, lockPath,
    `.github/extensions/${slug}/extension.mjs`, `.github/extensions/${slug}/workflow.mjs`,
    `.github/extensions/${slug}/support/.fixture.json`, `.github/extensions/${slug}/workflow.test.mjs`,
    "actions/setup/js/copilot_workflow_events.cjs", "actions/setup/js/copilot_session.cjs",
    "actions/setup/js/copilot_dynamic_workflow.test.cjs", "actions/setup/js/copilot_sdk_session.cjs",
    "actions/setup/js/parse_copilot_log.cjs", "actions/setup/js/unified_session_payload.cjs",
    "actions/setup/sh/copy_copilot_session_state.sh", "actions/setup/sh/restore_base_github_folders.sh",
  ];
  const profile = sources.map(file => {
    const row = readSource(file);
    if (!row) throw new Error(`Missing source-review dependency: ${file}`);
    return { path: file, gitBlob: row.id, sha256: row.sha256 };
  });
  const tree = archive.metadata(["ls-tree", "-r", "--name-only", revision, ".github/workflows"]).split("\n");
  const callers = [];
  const scanned = tree.filter(file => /\.ya?ml$/.test(file) && !/\.lock\.yml$/.test(file));
  for (const file of scanned) {
    const row = readSource(file), workflow = parse(row.bytes.toString("utf8"));
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      if (job.uses === `./${lockPath}`) callers.push({ path: file, jobId, gitBlob: row.id, condition: job.if ?? null });
    }
  }
  const contract = {
    schemaVersion: 1, repository, repositoryId, workflowId: slug, sourceRevision: revision, until, adoption,
    sourceGitBlob: source.id, sourceProfileSha256: censusDigest(profile),
    packageSha256: censusDigest(profile.filter(row => row.path.startsWith(`.github/extensions/${slug}/`))),
    interpreterSha256: digest(readFileSync("scripts/copilot-dynamic-workflow-value.mjs")),
    sourceProfile: profile, callers, frozenBeforeAcquisition: true,
  };
  const contractPath = `${directory}/contract.json`;
  if (existsSync(contractPath) && censusDigest(readCensusJson(contractPath)) !== censusDigest(contract)) {
    throw new Error("Refusing to alter frozen dynamic-workflow contract");
  }
  writeCensusJson(contractPath, contract);
  const sourceHistory = [];
  for (const file of [sourcePath, `.github/extensions/${slug}`, ...new Set(callers.map(row => row.path))]) {
    const commits = [];
    for (let page = 1; page <= 10; page++) {
      const response = request(`repos/${repository}/commits?sha=${revision}&path=${encodeURIComponent(file)}&per_page=100&page=${page}`, rows => rows.map(row => ({
        sha: row.sha, at: row.commit.committer.date, parents: row.parents.map(parent => parent.sha),
      })));
      if (response.status !== "available") throw new Error("Cannot exhaust relevant source history");
      commits.push(...response.value);
      if (response.value.length < 100) break;
      if (page === 10) throw new Error("Relevant source history traversal remains incomplete");
    }
    sourceHistory.push({ path: file, commits });
  }
  const adoptionPackage = profile.filter(row => row.path.startsWith(`.github/extensions/${slug}/`) || row.path === sourcePath)
    .map(row => {
      const original = readSource(row.path, adoption.commit);
      if (!original) throw new Error("Missing adoption-time package source");
      return { path: row.path, adoptionGitBlob: original.id, frozenGitBlob: row.gitBlob, unchanged: original.id === row.gitBlob };
    });
  const historicalCallers = new Map(callers.map(row => [row.path, row]));
  const reviewedSourceVersions = new Set(), historicalReview = [];
  const reviewedSourceReferences = new Set();
  const historicalSourceGaps = new Map();
  const isEditableWorkflow = file => /^\.github\/workflows\/[^/]+\.(?:md|ya?ml)$/.test(file)
    && !file.endsWith(".lock.yml");
  const inspectCallerSource = (at, file) => {
    let row;
    try { row = readSource(file, at); }
    catch (error) {
      if (!(error instanceof DynamicSourceGap)) throw error;
      historicalSourceGaps.set(error.reference.gitBlob, error.reference);
      return;
    }
    if (!row || reviewedSourceReferences.has(`${file}:${row.id}`)) return;
    reviewedSourceReferences.add(`${file}:${row.id}`);
    reviewedSourceVersions.add(row.id);
    const text = row.bytes.toString("utf8");
    const yaml = file.endsWith(".md") ? text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] : text;
    if (yaml === undefined) return;
    const workflow = parse(yaml);
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      if (job.uses !== `./${lockPath}`) continue;
      const executionPath = file.endsWith(".md") ? file.replace(/\.md$/, ".lock.yml") : file;
      const execution = file.endsWith(".md") ? readSource(executionPath, at) : row;
      if (!execution || parse(execution.bytes.toString("utf8"))?.jobs?.[jobId]?.uses !== `./${lockPath}`) {
        throw new Error("Historical caller source lacks its matching executable workflow");
      }
      historicalCallers.set(executionPath, { path: executionPath, jobId, gitBlob: execution.id, condition: job.if ?? null });
      historicalReview.push({ at, sourcePath: file, sourceGitBlob: row.id, executionPath, executionGitBlob: execution.id, jobId });
    }
  };
  const adoptionTree = archive.metadata(["ls-tree", "-r", "--name-only", adoption.commit, ".github/workflows"]).split("\n");
  for (const file of adoptionTree.filter(isEditableWorkflow)) inspectCallerSource(adoption.commit, file);
  const commits = git(["log", "--first-parent", "--reverse", "--format=%H", `${adoption.commit}..${revision}`, "--", ".github/workflows"])
    .split("\n").filter(Boolean);
  for (const commit of commits) {
    const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", `${commit}^`, commit, "--", ".github/workflows"])
      .split("\n").filter(isEditableWorkflow);
    for (const file of changed) inspectCallerSource(commit, file);
  }
  const inventories = [];
  for (const workflowPath of [lockPath, ...historicalCallers.keys()]) {
    const rows = [], receipts = [];
    for (let page = 1; page <= 10; page++) {
      const endpoint = `repos/${repository}/actions/workflows/${path.basename(workflowPath)}/runs?created=${encodeURIComponent(`${adoption.adoptedAt}..${until}`)}&per_page=100&page=${page}`;
      const response = request(endpoint, row => ({
        total_count: row.total_count, workflow_runs: row.workflow_runs.map(run => ({
          id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha, path: run.path,
          event: run.event, created_at: run.created_at, headRepositoryId: run.head_repository?.id ?? null,
        })),
      }));
      if (response.status !== "available") throw new Error(`Cannot exhaust workflow inventory: ${workflowPath}`);
      receipts.push({ endpoint, responseSha256: response.responseSha256 });
      rows.push(...response.value.workflow_runs);
      if (rows.length === response.value.total_count) {
        validateRunInventory({ total_count: response.value.total_count, workflow_runs: rows }, workflowPath);
        break;
      }
      if (!response.value.workflow_runs.length || page === 10) throw new Error("Incomplete dynamic-workflow pagination");
    }
    inventories.push({ workflowPath, complete: true, rows, receipts });
  }
  const observations = [];
  for (const inventory of inventories) for (const run of inventory.rows) {
    if (run.created_at < adoption.adoptedAt || run.created_at >= until) continue;
    const jobs = request(`repos/${repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`, row => ({
      total_count: row.total_count, jobs: row.jobs.map(job => ({
        id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
        started_at: job.started_at, completed_at: job.completed_at,
        steps: job.steps?.map(step => ({
          name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
          started_at: step.started_at, completed_at: step.completed_at,
        })),
      })),
    }));
    if (jobs.status === "available" && jobs.value.total_count !== jobs.value.jobs.length) {
      throw new Error("Initial-attempt job inventory requires additional pagination; cannot claim complete");
    }
    const artifacts = request(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, row => ({
      total_count: row.total_count, artifacts: row.artifacts.map(item => ({
        id: item.id, name: item.name, expired: item.expired, digest: item.digest ?? null,
        size_in_bytes: item.size_in_bytes, created_at: item.created_at, expires_at: item.expires_at,
      })),
    }));
    if (artifacts.status === "available" && artifacts.value.total_count !== artifacts.value.artifacts.length) {
      throw new Error("Artifact inventory requires additional pagination; cannot claim complete");
    }
    const logEndpoint = `repos/${repository}/actions/runs/${run.id}/attempts/1/logs`;
    const logs = request(logEndpoint, bytes => {
      const temporary = mkdtempSync(path.join(apiCache, "log-inspection-"));
      try {
        const filename = path.join(temporary, "logs.zip");
        writeFileSync(filename, bytes);
        if (bytes.length === 22 && bytes.toString("hex") === "504b0506000000000000000000000000000000000000") {
          return { bytes: bytes.length, entries: [], emptyArchive: true };
        }
        const entries = execFileSync("unzip", ["-Z1", filename], {
          encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        }).trim().split("\n");
        if (entries.some(entry => entry.startsWith("/") || entry.split("/").includes(".."))) {
          throw new Error("Unsafe native log archive entry");
        }
        return { bytes: bytes.length, entries, emptyArchive: false,
          acceptance: "No source-defined protected dynamic-workflow verifier exists; arbitrary agent logs cannot establish independent invocation." };
      } finally {
        rmSync(temporary, { recursive: true });
      }
    }, true);
    observations.push({
      id: `${run.id}:1`, at: run.created_at, run,
      selection: classifyDynamicSelection(inventory.workflowPath, jobs),
      jobs, artifacts, logs, protectedProjection: null,
      missingReason: "No protected source-bound native invocation receipt. Empty jobs do not prove the reusable branch was skipped.",
    });
  }
  const part = "observations-001.json.gz";
  writeCensusJson(`${directory}/${part}`, observations);
  const index = {
    schemaVersion: 1, repository, repositoryId, sourceRevision: revision, until,
    contractSha256: censusDigest(contract), acquisitionComplete: true,
    acquisitionScope: "Complete direct and discovered-caller initial-attempt job/artifact/log inventories; historical source discovery completeness is separate.",
    complete: historicalSourceGaps.size === 0,
    historicalCallerCoverage: historicalSourceGaps.size
      ? "Incomplete: all immutable source references were enumerated, but unacquired source blobs remain after the shared API quota stop. Existing known-caller runtime inventories are complete; unknown historical callers are not an invented empty population."
      : "Every editable root workflow at adoption and every changed/deleted/intermediate source in the complete first-parent interval was inspected for native reusable calls; PR merge-ref branch selection remains unknown where initial-attempt jobs are absent.",
    directRuns: inventories.find(row => row.workflowPath === lockPath).rows.length,
    candidateAttempts: observations.length, eligibleAttempts: null, verifiedInvocations: 0,
    confirmedIneligible: observations.filter(row => row.selection === "protected-caller-skipped").length,
    unresolvedSelection: observations.filter(row => row.selection === "unknown-reusable-branch").length,
    measured: false, inventoryComplete: true, independentRuntimeEvidence: "unavailable",
    scannedNonGeneratedYaml: scanned.length, callers: [...historicalCallers.values()], inventories, sourceHistory, adoptionPackage,
    historicalCallerReview: { complete: historicalSourceGaps.size === 0, changedWorkflowCommits: commits.length,
      uniqueSourceVersions: reviewedSourceVersions.size, uniquePathVersions: reviewedSourceReferences.size, matches: historicalReview,
      scope: "Editable root .md/.yml/.yaml workflow sources with source-to-execution matching for actual callers. Arbitrary PR-only caller definitions outside reviewed first-parent history are not authorized source profiles." },
    sourceGaps: [...historicalSourceGaps.values()],
    sourceArchive: [...new Map([...archive.sources(), ...executableSources].map(row => [row.gitBlob, row])).values()],
    partitions: [{ file: part, count: observations.length, sha256: censusDigest(observations) }],
    limitations: [
      "All candidate runs are exhausted; missing branch selection prevents an exact eligible-opportunity denominator.",
      "The source has no protected native assertion gate; raw agent/session outputs remain corroborative, not an independent execution oracle.",
      "Native workflow lifecycle fields do not contain the exact durable result. Full acceptance requires a separately correlated protected result readback.",
      "No historical trend, causal attribution, keep/retire recommendation or cost is established.",
    ],
  };
  writeCensusJson(`${directory}/index.json`, index);
  const modulePath = `docs/operational-value/proof/functions/${slug}.mjs`;
  const relative = path.posix.relative(path.posix.dirname(modulePath), "scripts/copilot-dynamic-workflow-value.mjs");
  writeFileSync(modulePath, `import { copilotDynamicWorkflowModule } from ${JSON.stringify(relative)};\n\nexport const { definition, collectBatch, scoreMetric } = copilotDynamicWorkflowModule(${JSON.stringify(contract, null, 2)});\n`);
  return { contractSha256: censusDigest(contract), candidates: observations.length, direct: index.directRuns, measured: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: collect-copilot-dynamic-workflow-value.mjs BARE_CACHE API_CACHE");
  console.log(JSON.stringify(collectDynamicWorkflowValue(process.argv[2], process.argv[3])));
}
