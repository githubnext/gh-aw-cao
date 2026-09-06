import { mkdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { actionsLog as log } from "./actions-log.mjs";
import { admissionRecordFromArchive } from "./admission-evidence.mjs";
import {
  extractCaoFailureMessage,
  isFailedConclusion,
  performanceJobRecord,
  runFailureEvidence,
} from "./failure-evidence.mjs";
import {
  previousIndexCanRetainRuns,
  previousIndexIsReusable,
  previousRunRecords,
} from "./run-health-snapshot.mjs";
import { normalizeVersion, updateState } from "./version.mjs";

(async () => {
log.group`Discover deployed agentic workflows`;
try {

const repository = process.env.GITHUB_REPOSITORY || "";
const organization = process.env.REPORT_ORGANIZATION || repository.split("/")[0];
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const pagesToken = process.env.REPORT_PAGES_TOKEN || token;
const outputPath = path.resolve(process.env.REPORT_DEPLOYED_WORKFLOWS || "_activity/deployed-workflows.json");
const controlSettingsPath = process.env.REPORT_CONTROL_SETTINGS;
const policyPath = process.env.REPORT_CONTROL_POLICY;
const includePrivate = process.env.REPORT_INCLUDE_PRIVATE === "true";
const runWindowHours = Number(process.env.REPORT_RUN_WINDOW_HOURS || 7 * 24);
const auditMaxPages = Number(process.env.REPORT_AUDIT_MAX_PAGES || 100);
const maxRetryDelayMs = Number(process.env.REPORT_MAX_RETRY_SECONDS || 30) * 1000;
const FAILURE_EVIDENCE_RUNS_PER_WORKFLOW = 5;
const CAO_PRECOMPUTE_STEP = "Run CAO control precompute";
const MAX_ADMISSION_ARTIFACT_BYTES = 1024 * 1024;
if (!Number.isInteger(runWindowHours) || runWindowHours < 1 || runWindowHours > 24 * 31) {
  throw new Error("REPORT_RUN_WINDOW_HOURS must be an integer from 1 through 744");
}
const controlSettings = controlSettingsPath
  ? JSON.parse(readFileSync(controlSettingsPath, "utf8"))
  : {};
const controlPolicy = !controlSettingsPath && policyPath
  ? JSON.parse(readFileSync(policyPath, "utf8"))
  : {};
const checkedInRepositories = controlPolicy["control-plane"]?.scope?.["allowed-repositories"] || [];
if (!Array.isArray(checkedInRepositories)) {
  throw new Error("control-plane.scope.allowed-repositories must be an array");
}
const policyRepositories = [...new Set([
  ...(controlSettings.allowed_repositories || []),
  ...checkedInRepositories,
].map((value) => String(value).toLowerCase()))];
const requestedRepositories = [...new Set((process.env.REPORT_ALLOWED_REPOS || "").split(",")
  .map((value) => value.trim().toLowerCase()).filter(Boolean))];
if (policyRepositories.length > 0 && requestedRepositories.some((value) => !policyRepositories.includes(value))) {
  throw new Error("REPORT_ALLOWED_REPOS cannot widen checked-in control policy");
}
const allowedRepositories = requestedRepositories.length > 0 ? requestedRepositories : policyRepositories;
const repositoryScopeEnabled = allowedRepositories.length > 0;

if (!organization || !token) throw new Error("GITHUB_REPOSITORY (or REPORT_ORGANIZATION) and GITHUB_TOKEN are required");
if (allowedRepositories.some((value) => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(value))) {
  throw new Error("REPORT_ALLOWED_REPOS must contain comma-separated owner/repository values");
}

function markdownSourceUrl(lockUrl = "") {
  if (!lockUrl.endsWith(".lock.yml")) return lockUrl;
  return `${lockUrl.slice(0, -".lock.yml".length)}.md?plain=1`;
}

async function boundedResponseBuffer(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new Error(`response exceeds ${maximumBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (length > maximumBytes) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, length);
}

async function github(url, attempt = 0, authToken = token, responseType = "json") {
  const response = await fetch(`https://api.github.com${url}`, { headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": "central-agentic-pages",
    "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (response.ok) return {
    body: responseType === "text"
      ? await response.text()
      : responseType === "binary"
        ? await boundedResponseBuffer(response, MAX_ADMISSION_ARTIFACT_BYTES)
        : await response.json(),
    headers: response.headers,
  };
  if ((response.status === 403 || response.status === 429) && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.max(1000, resetAt - Date.now() + 1000);
    if (!Number.isFinite(delay) || delay > maxRetryDelayMs) {
      throw new Error(`GitHub API ${response.status} for ${url}; requested retry delay ${Math.ceil(delay / 1000)} seconds exceeds limit`);
    }
    log.warning`GitHub API ${response.status}; retrying ${url} in ${Math.ceil(delay / 1000)} seconds`;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return github(url, attempt + 1, authToken, responseType);
  }
  throw new Error(`GitHub API ${response.status} for ${url}`);
}

async function requirePrivatePages() {
  if (!includePrivate) return;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to verify private Pages access");
  const pages = (await github(`/repos/${repository}/pages`, 0, pagesToken)).body;
  if (pages.public !== false) {
    throw new Error(`Refusing to discover private repository data because GitHub Pages for ${repository} is not private`);
  }
}

await requirePrivatePages();

function searchQuery(minimum, maximum) {
  return `org:${organization} path:.github/workflows extension:yml "generated by gh-aw" size:${minimum}..${maximum}`;
}

async function searchCode(query) {
  const first = await github(`/search/code?q=${encodeURIComponent(query)}&per_page=100&page=1`);
  const total = Math.min(first.body.total_count || 0, 1000);
  const items = [...(first.body.items || [])];
  for (let page = 2; page <= Math.ceil(total / 100); page += 1) {
    const response = await github(`/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`);
    items.push(...(response.body.items || []));
  }
  return items;
}

async function searchPartition(minimum, maximum) {
  const query = searchQuery(minimum, maximum);
  const first = await github(`/search/code?q=${encodeURIComponent(query)}&per_page=100&page=1`);
  const total = first.body.total_count || 0;
  if (total > 1000 && minimum < maximum) {
    const midpoint = Math.floor((minimum + maximum) / 2);
    return [
      ...await searchPartition(minimum, midpoint),
      ...await searchPartition(midpoint + 1, maximum),
    ];
  }
  const items = [...(first.body.items || [])];
  const pages = Math.min(10, Math.ceil(total / 100));
  for (let page = 2; page <= pages; page += 1) {
    const response = await github(`/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`);
    items.push(...(response.body.items || []));
  }
  return items;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function registeredWorkflows(repositoryName) {
  const workflows = [];
  try {
    for (let page = 1; ; page += 1) {
      const response = await github(`/repos/${repositoryName}/actions/workflows?per_page=100&page=${page}`);
      workflows.push(...(response.body.workflows || []));
      if ((response.body.workflows || []).length < 100) break;
    }
  } catch (error) {
    log.warning`${error.message}; retaining discovered files with unknown state`;
  }
  return new Map(workflows.map((workflow) => [workflow.path, workflow]));
}

async function repositoryMetadata(repositoryName) {
  try {
    return (await github(`/repos/${repositoryName}`)).body;
  } catch (error) {
    log.warning`${error.message}; repository visibility will be unknown`;
    return {};
  }
}

async function organizationRepositorySummary() {
  if (repositoryScopeEnabled) return { public: null, private: null, internal: null, total: null };
  try {
    async function count(type) {
      const response = await github(`/orgs/${organization}/repos?type=${type}&per_page=1&page=1`);
      const lastPage = response.headers.get("link")?.match(/[?&]page=(\d+)>; rel="last"/)?.[1];
      return lastPage ? Number(lastPage) : response.body.length;
    }
    const [total, publicRepositories, privateRepositories] = await Promise.all([
      count("all"),
      count("public"),
      count("private"),
    ]);
    return {
      public: publicRepositories,
      private: privateRepositories,
      internal: total - publicRepositories - privateRepositories,
      total,
    };
  } catch (error) {
    log.warning`${error.message}; organization repository totals will be unavailable`;
    return { public: null, private: null, internal: null, total: null };
  }
}

async function fileContent(repositoryName, filePath) {
  const response = await github(`/repos/${repositoryName}/contents/${encodeURIComponent(filePath).replaceAll("%2F", "/")}`);
  return Buffer.from(response.body.content || "", "base64").toString("utf8");
}

function ghAwPayloads(source) {
  const prefixes = {
    ghAwMetadata: "# gh-aw-metadata: ",
    ghAwManifest: "# gh-aw-manifest: ",
  };
  const payloads = { ghAwMetadata: null, ghAwManifest: null };
  for (const line of source.split("\n")) {
    for (const [name, prefix] of Object.entries(prefixes)) {
      if (!line.startsWith(prefix)) continue;
      try {
        const payload = JSON.parse(line.slice(prefix.length));
        if (payload && typeof payload === "object" && !Array.isArray(payload)) payloads[name] = payload;
      } catch {
        // Malformed generated metadata is unavailable rather than partially parsed.
      }
    }
  }
  return payloads;
}

async function latestGhAwVersion() {
  try {
    const version = (await github("/repos/github/gh-aw/releases/latest")).body.tag_name;
    return normalizeVersion(version);
  } catch (error) {
    log.warning`${error.message}; gh-aw update state will be unknown`;
    return null;
  }
}

async function repositoryManifestFiles(repositoryName) {
  const metadata = await repositoryMetadata(repositoryName);
  if (!metadata.default_branch || (metadata.private && !includePrivate && repositoryName !== repository)) return [];
  const tree = (await github(`/repos/${repositoryName}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`)).body.tree || [];
  return tree.filter((item) => item.type === "blob" && item.path.split("/").at(-1) === "aw.yml").map((item) => ({
    path: item.path,
    repository: metadata,
  }));
}

function manifestScalar(source, key) {
  const value = source.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1]?.trim() || "";
  return value.replace(/^['"]|['"]$/g, "");
}

function manifestWorkflowSources(source) {
  const includes = source.match(/^includes:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] || "";
  return includes.split("\n").flatMap((line) => {
    const value = line.match(/^\s*-\s+(?:source:\s+)?([^#]+)$/)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    return value?.startsWith(".github/workflows/") && value.endsWith(".md") ? [value] : [];
  });
}

function declaresOperationalValue(source) {
  const graders = source.match(/^graders:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] || "";
  return /^\s+operational-value:\s*(?:$|#)/m.test(graders);
}

function workflowRole(source) {
  return source.match(/uses:\s+shared\/(?:cao|control)\.md[\s\S]*?role:\s+(orchestrator|worker)/)?.[1] || "standalone";
}

function workflowWorkerIds(source) {
  const inline = source.match(/^[ \t]+workflows:[ \t]*\[([^\]]*)\]/m)?.[1];
  if (inline !== undefined) return inline.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  const block = source.match(/^[ \t]+workflows:[ \t]*\n((?:^[ \t]+-[ \t]+.*\n?)*)/m)?.[1] || "";
  return block.split("\n")
    .map((line) => line.match(/^\s*-\s+([^#]+)$/)?.[1]?.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

async function workflowCapabilities(repositoryName, lockPath, registryOnly) {
  const sourcePath = lockPath.replace(/\.lock\.yml$/, ".md");
  const [source, lock] = await Promise.allSettled([
    fileContent(repositoryName, sourcePath),
    fileContent(repositoryName, lockPath),
  ]);
  const payloads = lock.status === "fulfilled"
    ? ghAwPayloads(lock.value)
    : { ghAwMetadata: null, ghAwManifest: null };
  const ghAwVersion = normalizeVersion(payloads.ghAwMetadata?.compiler_version);
  try {
    if (source.status !== "fulfilled") throw source.reason;
    const role = workflowRole(source.value);
    return {
      operationalValue: declaresOperationalValue(source.value),
      role,
      workers: role === "orchestrator" ? workflowWorkerIds(source.value) : [],
      sourceAvailable: true,
      ghAwVersion,
      ...payloads,
    };
  } catch (error) {
    const sourceMissing = /GitHub API 404\b/.test(error.message);
    const staleRegistration = sourceMissing && registryOnly;
    if (!staleRegistration) {
      log.warning`${error.message}; workflow capabilities are unknown for ${repositoryName}/${sourcePath}`;
    }
    return {
      operationalValue: null,
      role: "unknown",
      workers: [],
      sourceAvailable: sourceMissing ? false : null,
      staleRegistration,
      ghAwVersion,
      ...payloads,
    };
  }
}

function nextPagePath(headers) {
  return headers.get("link")?.match(/<https:\/\/api\.github\.com([^>]+)>; rel="next"/)?.[1] || "";
}

function collectionFailure(error, fallback = "request") {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(message.match(/GitHub API (\d{3})/)?.[1]);
  const failureClass = status === 429 || (status === 403 && /rate|retry delay/i.test(message))
    ? "rate-limit"
    : status === 401 || status === 403
      ? "permission"
      : /timed?\s*out|abort/i.test(message)
        ? "timeout"
        : fallback;
  return { failureClass, status: Number.isFinite(status) ? status : null, reason: message };
}

function needsFailureEvidence(run) {
  if (run.admissionReason) return false;
  if (!run.failureJob && !run.failureStep) return true;
  return run.failureStep === CAO_PRECOMPUTE_STEP && !run.failureMessage && !run.failureLogChecked;
}

function emptyRunHealth() {
  return {
    runs: 0,
    successful: 0,
    failed: 0,
    actionRequired: 0,
    cancelled: 0,
    skipped: 0,
    pending: 0,
    other: 0,
    runIds: [],
    runRecords: [],
  };
}

async function collectRunHealth(registryByRepository, previousIndex) {
  const windowStart = new Date(Date.now() - runWindowHours * 60 * 60 * 1000);
  const previousIndexContext = {
    organization,
    repositoryScope: repositoryScopeEnabled ? "allowlist" : "organization",
    includePrivate,
    runWindowHours,
    allowedRepositories,
  };
  const retainPreviousRuns = previousIndexCanRetainRuns(previousIndex, windowStart, previousIndexContext);
  const reusable = previousIndexIsReusable(previousIndex, windowStart, previousIndexContext);
  const overlapStart = reusable
    ? new Date(Math.max(windowStart.getTime(), Date.parse(previousIndex.generatedAt) - 60 * 60 * 1000))
    : windowStart;
  let page = 0;
  let complete = true;
  let available = true;
  const collections = [];
  const records = previousRunRecords(retainPreviousRuns ? previousIndex : null, registryByRepository, windowStart);
  const previousWorkflowIds = new Map();
  const repositoriesWithPendingRuns = new Set();
  for (const workflow of previousIndex?.workflows || []) {
    if (!previousWorkflowIds.has(workflow.repository)) previousWorkflowIds.set(workflow.repository, new Set());
    previousWorkflowIds.get(workflow.repository).add(workflow.id);
    if ((workflow.runHealth?.runRecords || []).some((run) => run.conclusion === null || run.status !== "completed")) {
      repositoriesWithPendingRuns.add(workflow.repository);
    }
  }
  await mapWithConcurrency([...registryByRepository], 4, async ([repositoryName, registry]) => {
    const workflowIds = new Set([...registry.values()].map((workflow) => workflow.id));
    const knownWorkflowIds = previousWorkflowIds.get(repositoryName);
    const refreshStart = reusable && knownWorkflowIds
      && !repositoriesWithPendingRuns.has(repositoryName)
      && [...workflowIds].every((id) => knownWorkflowIds.has(id))
      ? overlapStart
      : windowStart;
    try {
      for (let repositoryPage = 1; repositoryPage <= auditMaxPages; repositoryPage += 1) {
        const response = await github(`/repos/${repositoryName}/actions/runs?created=${encodeURIComponent(`>=${refreshStart.toISOString()}`)}&per_page=100&page=${repositoryPage}`);
        const runs = response.body.workflow_runs || [];
        page += 1;
        for (const run of runs) {
          if (!workflowIds.has(run.workflow_id)) continue;
          const recordKey = `${run.workflow_id}:${run.id}`;
          const previousRun = records.get(recordKey)?.run;
          records.set(recordKey, { workflowId: run.workflow_id, run: {
            repository: repositoryName,
            runId: run.id,
            runNumber: run.run_number,
            runAttempt: run.run_attempt,
            event: run.event,
            conclusion: run.conclusion,
            status: run.status,
            createdAt: run.created_at,
            startedAt: run.run_started_at,
            updatedAt: run.updated_at,
            displayTitle: run.display_title,
            ...(previousRun?.jobsCollected && previousRun.runAttempt === run.run_attempt ? {
              jobsCollected: true,
              jobs: previousRun.jobs,
            } : {}),
            ...(previousRun?.admission && previousRun.runAttempt === run.run_attempt ? {
              admission: previousRun.admission,
            } : {}),
          } });
        }
        if (runs.length < 100) break;
        if (repositoryPage === auditMaxPages) complete = false;
      }
    } catch (error) {
      available = false;
      complete = false;
      collections.push({
        operation: "run-query",
        repository: repositoryName,
        state: "failed",
        ...collectionFailure(error),
      });
      log.warning`${error.message}; run health will be unavailable for ${repositoryName}`;
    }
  });

  const admissionEvidence = { available: true, complete: true };
  const recordsByRepository = new Map();
  for (const { run } of records.values()) {
    if (!recordsByRepository.has(run.repository)) recordsByRepository.set(run.repository, new Map());
    recordsByRepository.get(run.repository).set(String(run.runId), run);
  }
  await mapWithConcurrency([...recordsByRepository], 4, async ([repositoryName, repositoryRuns]) => {
    try {
      const artifactsByRun = new Map();
      for (let artifactPage = 1; artifactPage <= auditMaxPages; artifactPage += 1) {
        const response = await github(`/repos/${repositoryName}/actions/artifacts?name=cao-admission&per_page=100&page=${artifactPage}`);
        const artifacts = response.body.artifacts || [];
        for (const artifact of artifacts) {
          const runId = String(artifact.workflow_run?.id || "");
          if (!artifact.expired && repositoryRuns.has(runId) && !artifactsByRun.has(runId)) {
            artifactsByRun.set(runId, artifact);
          }
        }
        if (artifacts.length < 100) break;
        if (artifactPage === auditMaxPages) admissionEvidence.complete = false;
      }
      const admissionDirectory = path.join(process.env.RUNNER_TEMP || "/tmp", "cao-activity", "admissions");
      await mkdir(admissionDirectory, { recursive: true });
      await mapWithConcurrency([...artifactsByRun], 4, async ([runId, artifact]) => {
        const run = repositoryRuns.get(runId);
        if (run.admission) return;
        const archivePath = path.join(admissionDirectory, `${artifact.id}.zip`);
        try {
          const response = await github(`/repos/${repositoryName}/actions/artifacts/${artifact.id}/zip`, 0, token, "binary");
          await writeFile(archivePath, response.body);
          const admission = admissionRecordFromArchive(archivePath, {
            repository: repositoryName,
            runId,
            runAttempt: run.runAttempt,
          });
          if (!admission) throw new Error("admission artifact is invalid");
          run.admission = admission;
        } catch (error) {
          admissionEvidence.complete = false;
          collections.push({
            operation: "artifact-download",
            repository: repositoryName,
            runId,
            state: "failed",
            ...collectionFailure(error, /invalid/i.test(error.message) ? "parser" : "artifact-download"),
          });
          log.warning`${error.message}; admission evidence will be unavailable for run ${runId}`;
        } finally {
          await unlink(archivePath).catch(() => {});
        }
      });
    } catch (error) {
      admissionEvidence.available = false;
      admissionEvidence.complete = false;
      collections.push({
        operation: "artifact-list",
        repository: repositoryName,
        state: "failed",
        ...collectionFailure(error, "artifact-download"),
      });
      log.warning`${error.message}; admission evidence will be unavailable for ${repositoryName}`;
    }
  });

  const totals = new Map();
  for (const { workflowId, run } of records.values()) {
    const current = totals.get(workflowId) || emptyRunHealth();
    current.runRecords.push(run);
    totals.set(workflowId, current);
  }
  for (const current of totals.values()) {
    current.runRecords.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || right.runAttempt - left.runAttempt);
    current.runIds = current.runRecords.map((run) => run.runId);
    current.runs = current.runRecords.length;
    for (const run of current.runRecords) {
      if (run.conclusion === "success") current.successful += 1;
      else if (run.conclusion === "action_required") current.actionRequired += 1;
      else if (isFailedConclusion(run.conclusion)) current.failed += 1;
      else if (run.conclusion === "cancelled") current.cancelled += 1;
      else if (run.conclusion === "skipped") current.skipped += 1;
      else if (run.conclusion === null) current.pending += 1;
      else current.other += 1;
    }
  }
  const jobsByRun = new Map();
  const runsNeedingJobs = [...totals.values()]
    .flatMap((current) => current.runRecords)
    .filter((run) => !run.jobsCollected || run.status !== "completed");
  await mapWithConcurrency(runsNeedingJobs, 4, async (run) => {
    try {
      const jobs = [];
      for (let jobsPage = 1; jobsPage <= auditMaxPages; jobsPage += 1) {
        const response = await github(`/repos/${run.repository}/actions/runs/${run.runId}/jobs?filter=latest&per_page=100&page=${jobsPage}`);
        const pageJobs = response.body.jobs || [];
        jobs.push(...pageJobs);
        if (pageJobs.length < 100) break;
        if (jobsPage === auditMaxPages) complete = false;
      }
      jobsByRun.set(`${run.repository}:${run.runId}`, jobs);
      run.jobs = jobs.map(performanceJobRecord);
      run.jobsCollected = true;
    } catch (error) {
      complete = false;
      collections.push({
        operation: "job-query",
        repository: run.repository,
        runId: String(run.runId),
        state: "failed",
        ...collectionFailure(error),
      });
      log.warning`${error.message}; performance job details will be unavailable for run ${run.runId}`;
    }
  });
  const runsNeedingFailureEvidence = new Map();
  for (const current of totals.values()) {
    const latest = current.runRecords[0];
    if (isFailedConclusion(latest?.conclusion) && needsFailureEvidence(latest)) {
      runsNeedingFailureEvidence.set(`${latest.repository}:${latest.runId}`, latest);
    }
    const unresolvedDispatches = current.runRecords.filter((run) => (
      run.event === "workflow_dispatch"
      && isFailedConclusion(run.conclusion)
      && needsFailureEvidence(run)
    )).slice(0, FAILURE_EVIDENCE_RUNS_PER_WORKFLOW);
    for (const run of unresolvedDispatches) {
      runsNeedingFailureEvidence.set(`${run.repository}:${run.runId}`, run);
    }
  }
  await mapWithConcurrency([...runsNeedingFailureEvidence.values()], 4, async (run) => {
    try {
      let jobs = jobsByRun.get(`${run.repository}:${run.runId}`);
      if (!jobs) {
        const response = await github(`/repos/${run.repository}/actions/runs/${run.runId}/jobs?filter=latest&per_page=100`);
        jobs = response.body.jobs || [];
      }
      const { failureJobId, ...evidence } = runFailureEvidence(jobs);
      Object.assign(run, evidence);
      if (!run.admissionReason && failureJobId && run.failureStep === CAO_PRECOMPUTE_STEP) {
        try {
          const logs = await github(`/repos/${run.repository}/actions/jobs/${failureJobId}/logs`, 0, token, "text");
          const failureMessage = extractCaoFailureMessage(logs.body);
          run.failureLogChecked = true;
          if (failureMessage) run.failureMessage = failureMessage;
        } catch (error) {
          complete = false;
          collections.push({
            operation: "failure-log",
            repository: run.repository,
            runId: String(run.runId),
            state: "failed",
            ...collectionFailure(error),
          });
          log.warning`${error.message}; failure log details will be unavailable for run ${run.runId}`;
        }
      }
    } catch (error) {
      complete = false;
      collections.push({
        operation: "failure-evidence",
        repository: run.repository,
        runId: String(run.runId),
        state: "failed",
        ...collectionFailure(error, "parser"),
      });
      log.warning`${error.message}; failure details will be unavailable for run ${run.runId}`;
    }
  });
  return {
    available,
    complete,
    mode: reusable ? "incremental" : "full",
    refreshStart: reusable ? overlapStart.toISOString() : windowStart.toISOString(),
    windowStart: windowStart.toISOString(),
    pages: page,
    admissionEvidence,
    collections,
    fallback: {
      used: retainPreviousRuns && !complete,
      snapshotGeneratedAt: retainPreviousRuns ? previousIndex?.generatedAt || null : null,
      snapshotAgeSeconds: retainPreviousRuns && previousIndex?.generatedAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(previousIndex.generatedAt)) / 1000))
        : null,
    },
    totals,
  };
}

let previousIndex = null;
try {
  previousIndex = JSON.parse(readFileSync(outputPath, "utf8"));
} catch {
  // A missing or malformed cache entry triggers a complete bounded refresh.
}
log.info`Activity discovery configuration: organization=${organization}, scope=${repositoryScopeEnabled ? "allowlist" : "organization"}, allowed repositories=${allowedRepositories.length}, include private=${includePrivate}, cached index=${previousIndex ? "available" : "unavailable"}`;

let matches = [];
let manifestMatches = [];
let workflowSearchAvailable = true;
let manifestSearchAvailable = true;
if (!repositoryScopeEnabled) {
  try {
    matches = await searchPartition(0, 499999);
  } catch (error) {
    workflowSearchAvailable = false;
    log.warning`${error.message}; organization workflow search will be unavailable`;
  }
  try {
    manifestMatches = await searchCode(`org:${organization} filename:aw.yml`);
  } catch (error) {
    manifestSearchAvailable = false;
    log.warning`${error.message}; organization package search will be unavailable`;
  }
} else {
  manifestMatches = (await mapWithConcurrency([repository, ...allowedRepositories], 8, async (repositoryName) => {
    try {
      return await repositoryManifestFiles(repositoryName);
    } catch (error) {
      manifestSearchAvailable = false;
      log.warning`${error.message}; package manifest discovery will be unavailable for ${repositoryName}`;
      return [];
    }
  })).flat();
}
log.info`Discovery searches returned ${matches.length} workflow lock files and ${manifestMatches.length} package manifests`;
const discovered = new Map();
const codeSearchWorkflowKeys = new Set();
for (const item of matches) {
  if (!item.path.startsWith(".github/workflows/") || !item.path.endsWith(".lock.yml")) continue;
  if (item.repository.private && !includePrivate) continue;
  const key = `${item.repository.full_name}:${item.path}`;
  codeSearchWorkflowKeys.add(key);
  discovered.set(key, {
    repository: item.repository.full_name,
    visibility: item.repository.visibility?.toLowerCase() || (item.repository.private ? "private" : "public"),
    path: item.path,
    sourceUrl: item.html_url,
  });
}

const manifestFiles = manifestMatches.filter((item) => item.path.split("/").at(-1) === "aw.yml" && (includePrivate || !item.repository.private));
const repositoryNames = [...new Set(repositoryScopeEnabled ? [repository, ...allowedRepositories] : [
  repository, ...[...discovered.values()].map((item) => item.repository), ...manifestFiles.map((item) => item.repository.full_name),
])].sort();
const registryByRepository = new Map((await mapWithConcurrency(repositoryNames, 8, async (repositoryName) => [
  repositoryName,
  await registeredWorkflows(repositoryName),
])).filter(Boolean));
const registeredWorkflowCount = [...registryByRepository.values()]
  .reduce((total, workflows) => total + workflows.size, 0);
log.info`Actions registry returned ${registeredWorkflowCount} workflows across ${repositoryNames.length} repositories`;

for (const repositoryName of repositoryNames) {
  const metadata = await repositoryMetadata(repositoryName);
  if (metadata.private && !includePrivate && repositoryName !== repository) continue;
  for (const workflow of registryByRepository.get(repositoryName)?.values() || []) {
    if (!workflow.path.startsWith(".github/workflows/") || !workflow.path.endsWith(".lock.yml")) continue;
    discovered.set(`${repositoryName}:${workflow.path}`, {
      repository: repositoryName,
      visibility: metadata.visibility?.toLowerCase() || (metadata.private ? "private" : "public"),
      path: workflow.path,
      sourceUrl: workflow.html_url,
    });
  }
}
log.info`Inspecting ${discovered.size} unique workflow candidates (${codeSearchWorkflowKeys.size} found by current code search, ${discovered.size - codeSearchWorkflowKeys.size} found only in the Actions registry)`;

const bundles = (await mapWithConcurrency(manifestFiles, 8, async (item) => {
  try {
    const source = await fileContent(item.repository.full_name, item.path);
    const registry = registryByRepository.get(item.repository.full_name);
    const includedWorkflows = manifestWorkflowSources(source).map((sourcePath) => {
      const lockPath = sourcePath.replace(/\.md$/, ".lock.yml");
      const registered = registry?.get(lockPath);
      return {
        sourcePath,
        lockPath,
        id: registered?.id || null,
        name: registered?.name || lockPath.split("/").at(-1).replace(/\.lock\.yml$/, ""),
        state: registered?.state || "unknown",
      };
    });
    return {
      repository: item.repository.full_name,
      visibility: item.repository.visibility?.toLowerCase() || (item.repository.private ? "private" : "public"),
      path: item.path,
      name: manifestScalar(source, "name") || item.path.replace(/\/aw\.yml$|^aw\.yml$/g, "") || item.repository.name,
      description: manifestScalar(source, "description"),
      workflows: includedWorkflows,
    };
  } catch (error) {
    log.warning`${error.message}; skipping package manifest ${item.repository.full_name}/${item.path}`;
    return null;
  }
})).filter(Boolean).sort((left, right) => left.repository.localeCompare(right.repository) || left.name.localeCompare(right.name));

const [runHealth, organizationRepositories, latestVersion] = await Promise.all([
  collectRunHealth(registryByRepository, previousIndex),
  organizationRepositorySummary(),
  latestGhAwVersion(),
]);

const staleRegistrationsByRepository = new Map();
const discoveredWorkflows = await mapWithConcurrency([...discovered.values()], 8, async (item) => {
  const registered = registryByRepository.get(item.repository)?.get(item.path);
  const { staleRegistration, ...capabilities } = await workflowCapabilities(
    item.repository,
    item.path,
    !codeSearchWorkflowKeys.has(`${item.repository}:${item.path}`),
  );
  if (staleRegistration) {
    log.debug`Stale Actions workflow registration: ${item.repository}/${item.path}`;
    staleRegistrationsByRepository.set(
      item.repository,
      (staleRegistrationsByRepository.get(item.repository) || 0) + 1,
    );
  }
  return {
    ...item,
    id: registered?.id || null,
    name: registered?.name || item.path.split("/").at(-1).replace(/\.lock\.yml$/, ""),
    state: registered?.state || "unknown",
    htmlUrl: markdownSourceUrl(registered?.html_url || item.sourceUrl) || `https://github.com/${item.repository}/actions`,
    createdAt: registered?.created_at || null,
    updatedAt: registered?.updated_at || null,
    runHealth: registered ? runHealth.totals.get(registered.id) || { runs: 0, successful: 0, failed: 0, actionRequired: 0, cancelled: 0, skipped: 0, pending: 0, other: 0, runIds: [], runRecords: [] } : null,
    ...capabilities,
    currentGhAwVersion: latestVersion,
    updateState: updateState(capabilities.ghAwVersion, latestVersion),
  };
});
const staleRegistrationCount = [...staleRegistrationsByRepository.values()]
  .reduce((total, count) => total + count, 0);
if (staleRegistrationCount > 0) {
  const repositories = [...staleRegistrationsByRepository.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
  log.notice`Ignored ${staleRegistrationCount} stale Actions workflow registrations whose Markdown sources are absent from the default branch (${repositories})`;
}
const missingSourceCount = discoveredWorkflows.filter((workflow) => workflow.sourceAvailable === false).length;
const workflows = discoveredWorkflows
  .filter((workflow) => workflow.sourceAvailable !== false)
  .sort((left, right) => left.repository.localeCompare(right.repository) || left.name.localeCompare(right.name));
const workflowByKey = new Map(workflows.map((workflow) => [`${workflow.repository}:${workflow.path}`, workflow]));
for (const bundle of bundles) {
  const expanded = new Map(bundle.workflows.map((workflow) => [workflow.lockPath, workflow]));
  for (const included of bundle.workflows) {
    const orchestrator = workflowByKey.get(`${bundle.repository}:${included.lockPath}`);
    for (const workerId of orchestrator?.workers || []) {
      const lockPath = `.github/workflows/${workerId}.lock.yml`;
      const worker = workflowByKey.get(`${bundle.repository}:${lockPath}`);
      if (worker) expanded.set(lockPath, {
        sourcePath: lockPath.replace(/\.lock\.yml$/, ".md"),
        lockPath,
        id: worker.id,
        name: worker.name,
        state: worker.state,
      });
    }
  }
  bundle.workflows = [...expanded.values()];
}
const operationWorkflowKeys = new Set(bundles.flatMap((bundle) => bundle.workflows.map((workflow) => `${bundle.repository}:${workflow.lockPath}`)));
const standaloneWorkflows = workflows.filter((workflow) => !operationWorkflowKeys.has(`${workflow.repository}:${workflow.path}`));

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  organization,
  repositoryScope: repositoryScopeEnabled ? "allowlist" : "organization",
  allowedRepositories,
  includePrivate,
  repositoryCount: repositoryNames.length,
  organizationRepositories,
  latestGhAwVersion: latestVersion,
  discovery: {
    workflowSearchAvailable,
    manifestSearchAvailable,
    operationalValueComplete: workflows.every((workflow) => workflow.operationalValue !== null),
    complete: workflowSearchAvailable
      && manifestSearchAvailable
      && workflows.every((workflow) => workflow.operationalValue !== null),
  },
  collections: [
    {
      operation: "workflow-discovery",
      state: workflowSearchAvailable ? "complete" : "failed",
      failureClass: workflowSearchAvailable ? null : "request",
      expected: repositoryScopeEnabled ? allowedRepositories.length : organizationRepositories.total,
      observed: repositoryNames.length,
    },
    {
      operation: "manifest-discovery",
      state: manifestSearchAvailable ? "complete" : "failed",
      failureClass: manifestSearchAvailable ? null : "request",
      observed: manifestFiles.length,
    },
    {
      operation: "run-query",
      state: runHealth.available ? runHealth.complete ? "complete" : "partial" : "failed",
      failureClass: runHealth.collections.find((item) => item.operation === "run-query")?.failureClass || null,
      expected: workflows.length,
      observed: runHealth.available ? workflows.length : null,
      pages: runHealth.pages,
      requestedWindowStart: runHealth.windowStart,
      observedWindowStart: runHealth.refreshStart,
      observedWindowEnd: new Date().toISOString(),
      fallback: runHealth.fallback,
    },
    {
      operation: "admission-artifacts",
      state: runHealth.admissionEvidence.available
        ? runHealth.admissionEvidence.complete ? "complete" : "partial"
        : "failed",
      failureClass: runHealth.collections.find((item) => item.operation.startsWith("artifact"))?.failureClass || null,
    },
    ...runHealth.collections,
  ],
  runHealth: {
    available: runHealth.available,
    complete: runHealth.complete,
    mode: runHealth.mode,
    refreshStart: runHealth.refreshStart,
    windowStart: runHealth.windowStart,
    windowHours: runWindowHours,
    pages: runHealth.pages,
    admissionEvidence: runHealth.admissionEvidence,
    fallback: runHealth.fallback,
  },
  bundles,
  standaloneWorkflows,
  workflows,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
log.info`Discovered ${bundles.length} packages and ${standaloneWorkflows.length} standalone workflows across ${repositoryNames.length} repositories; excluded ${missingSourceCount} workflows without authored sources; run health ${runHealth.available ? runHealth.complete ? "complete" : "partial" : "unavailable"}`;
} finally {
  log.endGroup();
}
})().catch((error) => {
  log.error`${error.stack || error.message || error}`;
  process.exitCode = 1;
});
