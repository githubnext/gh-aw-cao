import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { readGhAwLogShards } from "../../activity/gh-aw-logs.mjs";
import { hasOperationalValueResult, operationalValueRecordTime } from "./operational-value-records.mjs";

// The upstream protocol calls this grader `operational-value`. Within CAO its
// run-scoped results are operational graders, not package-defined repository
// operational values.

function metricValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricsFromResult(result) {
  return (Array.isArray(result.metrics) ? result.metrics : []).flatMap((metric) => (
    metric && typeof metric === "object" && typeof metric.id === "string" && metric.id
      ? [{ id: metric.id, value: metricValue(metric.value) }]
      : []
  ));
}

function runIdentity(record) {
  return [
    record.repository || "unknown-repository",
    record.workflowId || record.workflowPath || "unknown-workflow",
    record.runId ?? "unknown-run",
    record.runAttempt || 1,
  ].join(":");
}

function mergeRecords(...recordSets) {
  const records = new Map();
  for (const record of recordSets.flat()) {
    const key = runIdentity(record);
    const existing = records.get(key);
    // Legacy cached observations may be the only retained result for a run
    // when the current logs shard no longer includes that run.
    if (existing && hasOperationalValueResult(existing) && !hasOperationalValueResult(record)) continue;
    records.set(key, record);
  }
  return [...records.values()].sort((left, right) => (
    Date.parse(operationalValueRecordTime(left)) - Date.parse(operationalValueRecordTime(right))
      || runIdentity(left).localeCompare(runIdentity(right))
  ));
}

function normalizeResult(selected, result) {
  const metrics = metricsFromResult(result);
  return {
    schemaVersion: 1,
    repository: selected.repository,
    workflowId: selected.workflowId,
    workflowPath: selected.workflowPath || null,
    runId: selected.runId,
    runAttempt: selected.run?.runAttempt || selected.runAttempt || 1,
    runUrl: `https://github.com/${selected.repository}/actions/runs/${selected.runId}`,
    status: result.status || "unavailable",
    graderName: result.name || null,
    unit: result.unit || null,
    direction: result.direction || null,
    metrics,
    value: metrics.length > 0 ? metrics[0].value : metricValue(result.value),
    observedAt: selected.run?.updatedAt || selected.run?.createdAt || null,
    observationSource: "logs-jsonl",
    resultAvailable: true,
    error: result.error || null,
  };
}

function logsRunId(run) {
  return Number(run?.database_id ?? run?.run_id ?? run?.id);
}

function operationalValueResult(run) {
  const results = run?.graders?.results;
  const matches = (Array.isArray(results) ? results : [])
    .filter((result) => result.id === "operational-value" && result.source === "operational-value");
  return matches.length === 1 ? matches[0] : null;
}

export async function collectOperationalValues() {
  log.group`Collect operational-grader observations`;
  try {
    const inventoryPath = process.env.REPORT_DEPLOYED_WORKFLOWS;
    const logsPath = process.env.REPORT_GH_AW_LOGS_SHARDS;
    const outputPath = path.resolve(process.env.REPORT_OPERATIONAL_VALUES || "_inventory/operational-values.json");
    // Collection is incremental by default: fall back to the output path
    // itself as the cache so a missing REPORT_VALUE_CACHE cannot cause a
    // previously written snapshot to be silently discarded.
    const cachePath = process.env.REPORT_VALUE_CACHE ? path.resolve(process.env.REPORT_VALUE_CACHE) : outputPath;
    if (!inventoryPath) throw new Error("REPORT_DEPLOYED_WORKFLOWS is required");
    if (!logsPath) throw new Error("REPORT_GH_AW_LOGS_SHARDS is required");

    const generatedAt = new Date().toISOString();
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    // A missing/unreadable/malformed logs snapshot must not fail the whole
    // collector: an existing REPORT_VALUE_CACHE can still drive output
    // completeness for prior observations, so degrade to an empty snapshot.
    let logs = { runs: [] };
    try {
      logs.runs = await readGhAwLogShards(logsPath);
    } catch (error) {
      log.warning`Treating gh-aw logs JSONL at ${logsPath} as empty: ${error.message}`;
    }
    log.info`Processing ${logs.runs.length} cached gh-aw log records from ${logsPath}; cache output=${cachePath || "disabled"}`;

    const selectedRuns = [];
    const seen = new Set();
    for (const workflow of inventory.workflows || []) {
      if (workflow.operationalValue !== true) continue;
      const workflowId = workflow.path?.split("/").at(-1)?.replace(/\.lock\.yml$/, "");
      if (!workflowId) continue;
      const runRecords = new Map((workflow.runHealth?.runRecords || []).map((run) => [Number(run.runId), run]));
      for (const runId of workflow.runHealth?.runIds || []) {
        const key = `${workflow.repository}:${runId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const run = runRecords.get(Number(runId)) || null;
        selectedRuns.push({
          repository: workflow.repository,
          runId: Number(runId),
          workflowId,
          workflowPath: workflow.path,
          runAttempt: run?.runAttempt || 1,
          run,
        });
      }
    }

    let cachedRecords = [];
    if (cachePath) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        if (cached.schemaVersion === 1 && Array.isArray(cached.records)) {
          cachedRecords = cached.records;
          log.info`Loaded ${cachedRecords.length} cached operational-value records from ${cachePath}`;
        }
      } catch (error) {
        if (error.code === "ENOENT") log.info`No operational-value cache found at ${cachePath}`;
        else log.warning`Ignoring operational-value cache: ${error.message}`;
      }
    }

    const runsById = new Map(logs.runs
      .map((run) => [logsRunId(run), run])
      .filter(([runId]) => Number.isFinite(runId)));
    const cachedRunKeys = new Set(cachedRecords
      .filter(hasOperationalValueResult)
      .map(runIdentity));
    const currentRecords = [];
    let missingRuns = 0;
    for (const selected of selectedRuns) {
      if (cachedRunKeys.has(runIdentity(selected))) continue;
      const run = runsById.get(selected.runId);
      const result = operationalValueResult(run);
      if (!result) {
        missingRuns += 1;
        currentRecords.push({
          ...selected,
          schemaVersion: 1,
          runAttempt: selected.run?.runAttempt || 1,
          runUrl: `https://github.com/${selected.repository}/actions/runs/${selected.runId}`,
          status: "unavailable",
          value: null,
          metrics: [],
          observedAt: selected.run?.updatedAt || selected.run?.createdAt || null,
          observationSource: "logs-jsonl",
          resultAvailable: false,
          reason: run ? "operational grader result not found" : "run not found in gh-aw logs JSONL",
        });
        continue;
      }
      currentRecords.push(normalizeResult(selected, result));
    }

    const records = mergeRecords(cachedRecords, currentRecords);
    const evidenceTimes = records
      .map(operationalValueRecordTime)
      .filter(Boolean)
      .sort();
    const output = {
      schemaVersion: 1,
      generatedAt,
      window: {
        startAt: evidenceTimes[0] || inventory.runHealth?.windowStart || null,
        endAt: evidenceTimes.at(-1) || generatedAt,
      },
      complete: missingRuns === 0,
      collectionMode: "logs-jsonl",
      selectedRuns: selectedRuns.length,
      observedRuns: records.filter(hasOperationalValueResult).length,
      records,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    if (cachePath && cachePath !== outputPath) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(output, null, 2)}\n`);
      log.info`Updated operational-value cache at ${cachePath}`;
    }
    log.info`Collected ${output.observedRuns} operational-grader observations from ${output.selectedRuns} cached runs`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collectOperationalValues().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
