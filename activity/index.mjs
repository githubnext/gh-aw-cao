#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { actionsLog as log } from "./actions-log.mjs";
import { normalizeVersion } from "./version.mjs";

const EMPTY_RUN_HEALTH = {
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
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const USAGE_FIELDS = {
  runId: ["database_id", "run_id", "id"],
  workflow: ["workflow_path", "workflow_file", "workflow_file_path", "workflow_id", "workflow_name", "workflow"],
  runNumber: ["run_number", "number"],
  runAttempt: ["runAttempt", "run_attempt", "attempt"],
  event: ["event", "trigger"],
  conclusion: ["conclusion", "result"],
  status: ["status"],
  createdAt: ["created_at", "started_at"],
  startedAt: ["started_at"],
  updatedAt: ["updated_at", "completed_at"],
  displayTitle: ["display_title", "title"],
};

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function workflowPath(run) {
  const value = String(firstValue(
    run.workflow_path,
    run.workflow_file,
    run.workflow_file_path,
    run.workflow,
    "",
  ));
  if (value.startsWith(".github/workflows/")) {
    return value.replace(/\.md$/, ".lock.yml").replace(/(?<!\.lock)\.ya?ml$/, ".lock.yml");
  }
  return "";
}

function workflowAliases(workflow) {
  return [
    workflow.id,
    workflow.name,
    workflow.sourcePath,
    workflow.lockPath,
    workflow.lockPath?.split("/").at(-1)?.replace(/\.lock\.yml$/, ""),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
}

function runRecord(run, repository) {
  const runId = Number(firstValue(run.database_id, run.run_id, run.id));
  if (!Number.isSafeInteger(runId)) return null;
  const conclusion = firstValue(run.conclusion, run.result, null);
  const status = firstValue(run.status, conclusion ? "completed" : null);
  return {
    repository: firstValue(run.repository, run.repository_full_name, repository),
    runId,
    runNumber: Number(firstValue(run.run_number, run.number)) || null,
    runAttempt: Number(firstValue(run.runAttempt, run.run_attempt, run.attempt)) || 1,
    event: firstValue(run.event, run.trigger, null),
    conclusion,
    status,
    createdAt: firstValue(run.created_at, run.started_at, null),
    startedAt: firstValue(run.started_at, run.created_at, null),
    updatedAt: firstValue(run.updated_at, run.completed_at, null),
    displayTitle: firstValue(run.display_title, run.title, null),
    ...(run.failure_job ? { failureJob: String(run.failure_job) } : {}),
    ...(run.failure_step ? { failureStep: String(run.failure_step) } : {}),
    ...(run.failure_message ? { failureMessage: String(run.failure_message) } : {}),
  };
}

function summarizeRuns(records) {
  const result = structuredClone(EMPTY_RUN_HEALTH);
  result.runRecords = records.sort((left, right) => (
    Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0)
      || right.runAttempt - left.runAttempt
  ));
  result.runIds = result.runRecords.map((run) => run.runId);
  result.runs = result.runRecords.length;
  for (const run of result.runRecords) {
    if (run.conclusion === "success") result.successful += 1;
    else if (run.conclusion === "action_required") result.actionRequired += 1;
    else if (FAILED_CONCLUSIONS.has(run.conclusion)) result.failed += 1;
    else if (run.conclusion === "cancelled") result.cancelled += 1;
    else if (run.conclusion === "skipped") result.skipped += 1;
    else if (run.conclusion === null) result.pending += 1;
    else result.other += 1;
  }
  return result;
}

function usageArtifactGaps(runs) {
  const missing = Object.fromEntries(Object.keys(USAGE_FIELDS).map((field) => [field, 0]));
  const samples = {};
  for (const run of runs) {
    const runId = firstValue(run.database_id, run.run_id, run.id, "unknown");
    for (const [field, aliases] of Object.entries(USAGE_FIELDS)) {
      if (aliases.some((alias) => Object.hasOwn(run, alias))) continue;
      missing[field] += 1;
      if (!samples[field]) samples[field] = [];
      if (samples[field].length < 5) samples[field].push(String(runId));
    }
  }
  const missingFields = Object.fromEntries(Object.entries(missing).filter(([, count]) => count > 0));
  return {
    complete: Object.keys(missingFields).length === 0,
    observedRuns: runs.length,
    requiredFields: Object.keys(USAGE_FIELDS),
    missingFields,
    sampleRunIds: samples,
  };
}

function parseMetadata(lockSource) {
  const metadata = lockSource.match(/^# gh-aw-metadata: (.+)$/m)?.[1];
  const manifest = lockSource.match(/^# gh-aw-manifest: (.+)$/m)?.[1];
  function parse(value) {
    try {
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }
  return { ghAwMetadata: parse(metadata), ghAwManifest: parse(manifest) };
}

function declaresOperationalValue(source) {
  const graders = source.match(/^graders:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] || "";
  return /^\s+operational-value:\s*(?:$|#)/m.test(graders);
}

async function discoverLocalInventory(root) {
  const workflowDirectory = path.join(root, ".github", "workflows");
  const entries = await readdir(workflowDirectory, { withFileTypes: true });
  const workflows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    const sourcePath = `.github/workflows/${entry.name}`;
    const source = await readFile(path.join(root, sourcePath), "utf8");
    const role = source.match(/uses:\s+shared\/(?:cao|control)\.md[\s\S]*?role:\s+(orchestrator|worker)/)?.[1] || "standalone";
    const inlineWorkers = source.match(/^[ \t]+workflows:[ \t]*\[([^\]]*)\]/m)?.[1];
    const blockWorkers = source.match(/^([ \t]+)workflows:[ \t]*\r?\n((?:\1[ \t]+-[^\r\n]+\r?\n?)*)/m)?.[2];
    workflows.push({
      id,
      name: source.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] || id,
      role,
      sourcePath,
      lockPath: `.github/workflows/${id}.lock.yml`,
      compiled: entries.some((candidate) => candidate.name === `${id}.lock.yml`),
      workers: role === "orchestrator"
        ? (inlineWorkers
          ? inlineWorkers.split(",")
          : blockWorkers?.match(/^[ \t]*-[ \t]*(.+?)\s*$/gm)?.map((line) => line.replace(/^[ \t]*-[ \t]*/, "")) || []
        ).map((value) => value.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
        : [],
      package: null,
    });
  }
  return { schemaVersion: 1, manifests: [], workflows, bundles: [] };
}

async function main() {
  log.group`Build activity index from local workflow inventory`;
  try {
    const repository = process.env.GITHUB_REPOSITORY || "";
    const organization = process.env.REPORT_ORGANIZATION || repository.split("/")[0];
    const inventoryPath = process.env.REPORT_INVENTORY;
    const logsPath = process.env.REPORT_GH_AW_LOGS;
    const logsStatePath = process.env.REPORT_GH_AW_LOGS_STATE;
    const outputPath = path.resolve(process.env.REPORT_DEPLOYED_WORKFLOWS || "_activity/deployed-workflows.json");
    const root = path.resolve(process.env.REPORT_ROOT || ".");
    const windowDays = Number(process.env.REPORT_RUN_WINDOW_DAYS || 30);
    if (!repository || !logsPath || !logsStatePath) {
      throw new Error("GITHUB_REPOSITORY, REPORT_GH_AW_LOGS, and REPORT_GH_AW_LOGS_STATE are required");
    }
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) {
      throw new Error("REPORT_RUN_WINDOW_DAYS must be an integer from 1 through 31");
    }

    const [localInventory, logs, logsState] = await Promise.all([
      inventoryPath
        ? readFile(inventoryPath, "utf8").then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return discoverLocalInventory(root);
          throw error;
        })
        : discoverLocalInventory(root),
      readFile(logsPath, "utf8").then(JSON.parse),
      readFile(logsStatePath, "utf8").then(JSON.parse),
    ]);
    if (localInventory.schemaVersion !== 1 || !Array.isArray(localInventory.workflows)) {
      throw new Error(`Unsupported or invalid control-plane inventory: ${inventoryPath}`);
    }
    if (!Array.isArray(logs.runs)) throw new Error(`Unsupported or invalid gh aw logs snapshot: ${logsPath}`);
    const usageArtifact = usageArtifactGaps(logs.runs);
    if (!usageArtifact.complete) {
      log.warning`gh aw logs usage artifacts omit activity-index fields: ${Object.entries(usageArtifact.missingFields).map(([field, count]) => `${field} (${count})`).join(", ")}`;
    }

    const sourceByWorkflow = new Map();
    const lockByWorkflow = new Map();
    await Promise.all(localInventory.workflows.map(async (workflow) => {
      const [source, lock] = await Promise.all([
        readFile(path.join(root, workflow.sourcePath), "utf8").catch(() => ""),
        readFile(path.join(root, workflow.lockPath), "utf8").catch(() => ""),
      ]);
      sourceByWorkflow.set(workflow.id, source);
      lockByWorkflow.set(workflow.id, lock);
    }));

    const workflowByAlias = new Map();
    for (const workflow of localInventory.workflows) {
      for (const alias of workflowAliases(workflow)) workflowByAlias.set(alias, workflow);
    }
    const runsByWorkflow = new Map(localInventory.workflows.map((workflow) => [workflow.id, []]));
    for (const run of logs.runs) {
      const aliases = [
        workflowPath(run),
        firstValue(run.workflow_id, run.workflow_name, run.workflow),
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      const workflow = aliases.map((alias) => workflowByAlias.get(alias)).find(Boolean);
      const record = runRecord(run, repository);
      if (workflow && record) runsByWorkflow.get(workflow.id).push(record);
    }

    const workflows = localInventory.workflows.map((workflow) => {
      const source = sourceByWorkflow.get(workflow.id) || "";
      const { ghAwMetadata, ghAwManifest } = parseMetadata(lockByWorkflow.get(workflow.id) || "");
      const ghAwVersion = normalizeVersion(ghAwMetadata?.compiler_version);
      return {
        repository,
        visibility: "unknown",
        path: workflow.lockPath,
        sourceUrl: `https://github.com/${repository}/blob/${process.env.GITHUB_SHA || "main"}/${workflow.sourcePath}`,
        id: workflow.id,
        name: workflow.name,
        state: workflow.compiled ? "active" : "uncompiled",
        htmlUrl: `https://github.com/${repository}/blob/${process.env.GITHUB_SHA || "main"}/${workflow.sourcePath}`,
        createdAt: null,
        updatedAt: null,
        runHealth: summarizeRuns(runsByWorkflow.get(workflow.id)),
        operationalValue: declaresOperationalValue(source),
        role: workflow.role,
        workers: workflow.workers || [],
        sourceAvailable: Boolean(source),
        ghAwVersion,
        ghAwMetadata,
        ghAwManifest,
        currentGhAwVersion: null,
        updateState: "unknown",
      };
    }).sort((left, right) => left.name.localeCompare(right.name));

    const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const bundles = (localInventory.bundles || []).map((bundle) => {
      const orchestrator = workflowById.get(bundle.id);
      const members = [orchestrator, ...(bundle.workers || []).map((worker) => workflowById.get(worker.id))]
        .filter(Boolean);
      const packagePath = localInventory.workflows.find((workflow) => workflow.id === bundle.id)?.package?.path || "";
      return {
        repository,
        visibility: "unknown",
        path: packagePath,
        name: bundle.name,
        description: bundle.description,
        workflows: members.map((workflow) => ({
          sourcePath: workflow.path.replace(/\.lock\.yml$/, ".md"),
          lockPath: workflow.path,
          id: workflow.id,
          name: workflow.name,
          state: workflow.state,
        })),
      };
    });
    const packagedWorkflowIds = new Set(bundles.flatMap((bundle) => bundle.workflows.map((workflow) => workflow.id)));
    const standaloneWorkflows = workflows.filter((workflow) => !packagedWorkflowIds.has(workflow.id));
    const generatedAt = new Date().toISOString();
    const windowStart = new Date(Date.parse(generatedAt) - windowDays * 86_400_000).toISOString();
    const available = logsState.available === true;
    const complete = logsState.complete === true && usageArtifact.complete;
    const fallback = {
      used: logsState.fallback === true,
      snapshotGeneratedAt: logsState.fallback ? logsState.snapshotObservedAt || null : null,
      snapshotAgeSeconds: logsState.fallback && logsState.snapshotObservedAt
        ? Math.max(0, Math.floor((Date.parse(generatedAt) - Date.parse(logsState.snapshotObservedAt)) / 1000))
        : null,
    };
    const result = {
      schemaVersion: 1,
      generatedAt,
      organization,
      repositoryScope: "allowlist",
      allowedRepositories: [repository.toLowerCase()],
      includePrivate: false,
      repositoryCount: 1,
      organizationRepositories: { public: null, private: null, internal: null, total: null },
      latestGhAwVersion: null,
      discovery: {
        workflowSearchAvailable: true,
        manifestSearchAvailable: true,
        operationalValueComplete: true,
        complete: true,
      },
      collections: [
        {
          operation: "workflow-discovery",
          state: "complete",
          failureClass: null,
          expected: localInventory.workflows.length,
          observed: workflows.length,
        },
        {
          operation: "manifest-discovery",
          state: "complete",
          failureClass: null,
          observed: (localInventory.manifests || []).length,
        },
        {
          operation: "run-query",
          state: available ? complete ? "complete" : "partial" : "failed",
          failureClass: available ? null : "gh-aw-logs",
          expected: workflows.length,
          observed: available ? logsState.targetCount : null,
          requestedWindowStart: windowStart,
          observedWindowStart: windowStart,
          observedWindowEnd: generatedAt,
          fallback,
        },
        {
          operation: "usage-artifact-fields",
          state: usageArtifact.complete ? "complete" : "partial",
          failureClass: usageArtifact.complete ? null : "missing-data",
          ...usageArtifact,
        },
        {
          operation: "admission-artifacts",
          state: "unavailable",
          failureClass: "not-collected",
        },
      ],
      runHealth: {
        available,
        complete,
        mode: "full",
        refreshStart: windowStart,
        windowStart,
        windowHours: windowDays * 24,
        pages: null,
        admissionEvidence: { available: false, complete: false },
        usageArtifact,
        fallback,
      },
      bundles,
      standaloneWorkflows,
      workflows,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    log.info`Indexed ${workflows.length} checked-out workflows and ${logs.runs.length} gh aw log records without direct GitHub API requests`;
  } finally {
    log.endGroup();
  }
}

main().catch((error) => {
  log.error`${error.stack || error.message || error}`;
  process.exitCode = 1;
});
