function finiteValue(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function runAttempt(record) {
  const attempt = Number(record.runAttempt ?? record.run?.runAttempt ?? record.run?.attempt ?? 1);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
}

export function operationalValueRecordIdentity(record) {
  if (typeof record.observationId === "string" && record.observationId) return record.observationId;
  return [
    record.repository || "unknown-repository",
    record.workflowId || record.workflowPath || "unknown-workflow",
    record.runId ?? "unknown-run",
    runAttempt(record),
    record.evaluatorDigest || "unknown-evaluator",
  ].join(":");
}

export function operationalValueRunIdentity(record) {
  return [
    record.repository || "unknown-repository",
    record.workflowId || record.workflowPath || "unknown-workflow",
    record.runId ?? "unknown-run",
    runAttempt(record),
  ].join(":");
}

export function recordsFromOperationalValueReport(report) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.observations)) {
    throw new Error("unsupported gh-aw operational-value report");
  }
  return report.observations.map((observation) => {
    const record = {
      schemaVersion: 1,
      repository: report.repository,
      workflowId: report.workflowId,
      workflowPath: report.sourcePath,
      runId: observation.run?.id,
      runAttempt: runAttempt(observation),
      runUrl: observation.run?.url,
      status: observation.status || "unavailable",
      value: finiteValue(observation.value),
      baselineValue: finiteValue(observation.baselineValue),
      deltaFromBaseline: Number.isFinite(observation.deltaFromBaseline) ? observation.deltaFromBaseline : null,
      evaluatorDigest: observation.evaluatorDigest || report.evaluator?.sha256 || null,
      observation: {
        subject: {
          createdAt: observation.run?.createdAt,
        },
        evidenceAt: observation.evidenceAt,
        evidenceCutoff: observation.evidenceCutoff,
        opportunityKey: observation.opportunityKey,
        maturesAt: observation.maturesAt,
        mature: observation.mature === true,
        case: observation.case || {},
        provenance: observation.provenance || [],
      },
      observationSource: "report",
      diagnostics: observation.diagnostics || {},
      error: observation.status === "error" ? observation.message || "evaluator replay failed" : null,
    };
    record.observationId = observation.id || operationalValueRecordIdentity(record);
    return record;
  });
}

export function definitionFromOperationalValueReport(report) {
  return {
    repository: report.repository,
    workflowId: report.workflowId,
    workflowPath: report.sourcePath,
    evaluatorDigest: report.evaluator?.sha256 || null,
    operationalValue: report.operationalValue,
    baseline: report.baseline,
    diagnosticMetrics: (report.diagnostics || []).map((series) => series.metric),
  };
}

export function mergeOperationalValueRecords(...recordSets) {
  const records = new Map();
  for (const record of recordSets.flat()) {
    const key = operationalValueRecordIdentity(record);
    const existing = records.get(key);
    if (existing?.observationSource === "report" && record.observationSource !== "report") continue;
    if (existing?.observation && !record.observation) continue;
    records.set(key, { ...record, observationId: key });
  }
  // Placeholders persisted before an observation was collected key by
  // "unknown-evaluator" (no evaluatorDigest yet), so they can coexist in the
  // map alongside a later observed record for the same run. Drop those
  // stale placeholders once any observed record exists for the same run.
  const observedRunKeys = new Set([...records.values()]
    .filter((record) => record.status !== "unavailable")
    .map((record) => operationalValueRunIdentity(record)));
  for (const [key, record] of records) {
    if (record.status === "unavailable" && observedRunKeys.has(operationalValueRunIdentity(record))) {
      records.delete(key);
    }
  }
  return [...records.values()].sort((left, right) => {
    const leftTime = Date.parse(left.observation?.evidenceAt || left.run?.createdAt || "");
    const rightTime = Date.parse(right.observation?.evidenceAt || right.run?.createdAt || "");
    return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
      || operationalValueRecordIdentity(left).localeCompare(operationalValueRecordIdentity(right));
  });
}