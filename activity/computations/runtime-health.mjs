export const RUNTIME_HEALTH_MEASURE = Object.freeze({
  id: 'runtime-health',
  version: '1.0.0'
});

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const ATTENTION_ANSWERS = new Set(['no', 'not-observed', 'unknown']);
const TARGET_MEMBERSHIPS = new Set(['expected', 'observed-extra', 'unknown']);
const ERROR_GROUP_LIMIT = 20;
const RUN_REFERENCE_LIMIT = 20;

/** @param {unknown} value @param {string} field */
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

/** @param {unknown} value */
function optionalString(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/** @param {Record<string, unknown>} run */
function runTimestamp(run) {
  for (const field of ['runDate', 'startedAt', 'createdAt', 'updatedAt']) {
    const value = optionalString(run[field]);
    if (value !== null && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

/** @param {Record<string, unknown> & { runDate: string }} left @param {Record<string, unknown> & { runDate: string }} right */
function compareRequiredRunOrder(left, right) {
  if (left.runDate !== right.runDate) return left.runDate > right.runDate ? -1 : 1;
  const run = String(right.githubRunId ?? '').localeCompare(String(left.githubRunId ?? ''), undefined, {
    numeric: true
  });
  if (run) return run;
  return Number(right.attempt ?? 0) - Number(left.attempt ?? 0);
}

/** @param {Record<string, unknown>} run */
function errorKey(run) {
  for (const field of ['failureKind', 'classification', 'conclusion']) {
    const value = optionalString(run[field])?.trim().toLocaleLowerCase();
    if (value) return value;
  }
  return 'unknown-error';
}

/** @param {Record<string, unknown>} run */
function runReference(run) {
  return {
    runId: optionalString(run.id) ?? `github:run:${String(run.githubRunId)}:attempt:${String(run.attempt ?? 1)}`,
    githubRunId: run.githubRunId,
    attempt: Number(run.attempt ?? 1),
    status: optionalString(run.status) ?? 'unknown',
    conclusion: optionalString(run.conclusion),
    observedAt: run.runDate,
    url: optionalString(run.runLink)
  };
}

/** @param {Record<string, unknown>[]} runs */
function boundedLabels(runs) {
  /** @param {string} field */
  const values = (field) => [...new Set(runs
    .map((run) => optionalString(run[field])?.trim())
    .filter(Boolean))]
    .sort()
    .slice(0, RUN_REFERENCE_LIMIT);
  return {
    failureJobs: values('failureJob'),
    failureSteps: values('failureStep')
  };
}

/**
 * Evaluates one preselected orchestrator or worker-target partition.
 *
 * The query layer owns partition selection. This function owns only the
 * versioned measure semantics and therefore remains reusable by the data
 * worker, tests, CLI adapters, and notebooks.
 *
 * @param {{
 *   campaignId: string,
 *   workflowId: string,
 *   workflowRole: 'orchestrator'|'worker',
 *   workflowState?: string,
 *   targetRepositoryId?: string|null,
 *   targetScopeMembership?: 'expected'|'observed-extra'|'unknown'|null,
 *   evidenceQuality?: Record<string, unknown>|null,
 *   orderedNewestFirst: true,
 *   runs: Record<string, unknown>[]
 * }} partition
 */
export function evaluateRuntimeHealthPartition(partition) {
  const campaignId = requiredString(partition?.campaignId, 'partition.campaignId');
  const workflowId = requiredString(partition?.workflowId, 'partition.workflowId');
  if (!['orchestrator', 'worker'].includes(partition?.workflowRole)) {
    throw new TypeError('partition.workflowRole must be orchestrator or worker');
  }
  if (partition.orderedNewestFirst !== true) {
    throw new TypeError('partition.orderedNewestFirst must be true');
  }
  if (!Array.isArray(partition.runs)) throw new TypeError('partition.runs must be an array');

  const targetRepositoryId = optionalString(partition.targetRepositoryId);
  const targetScopeMembership = optionalString(partition.targetScopeMembership);
  if (partition.workflowRole === 'worker' && targetScopeMembership !== null
      && !TARGET_MEMBERSHIPS.has(targetScopeMembership)) {
    throw new TypeError('partition.targetScopeMembership is invalid');
  }

  const unknownDateRuns = [];
  const orderedRuns = [];
  for (const sourceRun of partition.runs) {
    const run = /** @type {Record<string, unknown> & { runDate: string | null }} */ ({
      ...sourceRun,
      runDate: runTimestamp(sourceRun)
    });
    if (run.runDate === null) unknownDateRuns.push(run);
    else orderedRuns.push(run);
  }
  for (let index = 1; index < orderedRuns.length; index += 1) {
    if (compareRequiredRunOrder(
      /** @type {Record<string, unknown> & { runDate: string }} */ (orderedRuns[index - 1]),
      /** @type {Record<string, unknown> & { runDate: string }} */ (orderedRuns[index])
    ) > 0) {
      throw new TypeError('partition.runs must be ordered newest-first by run date, GitHub run ID, and attempt');
    }
  }

  const runsSinceSuccess = [];
  let latestSuccess = null;
  let recordsVisited = 0;
  for (const run of orderedRuns) {
    recordsVisited += 1;
    if (run.conclusion === 'success') {
      latestSuccess = run;
      break;
    }
    runsSinceSuccess.push(run);
  }

  const terminalNonSuccesses = runsSinceSuccess.filter((run) => (
    run.status === 'completed' && run.conclusion !== 'success'
  ));
  const activeRuns = runsSinceSuccess.filter((run) => ACTIVE_STATUSES.has(String(run.status)));
  let answer;
  if (partition.runs.length === 0) answer = 'not-observed';
  else if (unknownDateRuns.length > 0 && orderedRuns.length === 0) answer = 'unknown';
  else if (terminalNonSuccesses.length > 0) answer = 'no';
  else if (activeRuns.length > 0) answer = 'running';
  else if (latestSuccess) answer = 'yes';
  else answer = 'unknown';

  /** @type {Map<string, Record<string, unknown>[]>} */
  const groupedErrors = new Map();
  for (const run of terminalNonSuccesses) {
    const key = errorKey(run);
    const group = groupedErrors.get(key) ?? [];
    group.push(run);
    groupedErrors.set(key, group);
  }
  const completeErrorGroups = [...groupedErrors.entries()]
    .map(([key, runs]) => ({
      errorKey: key,
      count: runs.length,
      distinctRunAttemptCount: new Set(runs.map((run) => runReference(run).runId)).size,
      conclusionCounts: Object.fromEntries([...new Set(runs.map((run) => (
        optionalString(run.conclusion) ?? 'unknown'
      )))].sort().map((conclusion) => [
        conclusion,
        runs.filter((run) => (optionalString(run.conclusion) ?? 'unknown') === conclusion).length
      ])),
      latestObservedAt: runs[0].runDate,
      ...boundedLabels(runs),
      runReferences: runs.slice(0, RUN_REFERENCE_LIMIT).map(runReference),
      omittedRunReferenceCount: Math.max(0, runs.length - RUN_REFERENCE_LIMIT),
      runReferenceLimit: RUN_REFERENCE_LIMIT
    }))
    .sort((left, right) => (
      right.count - left.count
      || String(right.latestObservedAt).localeCompare(String(left.latestObservedAt))
      || left.errorKey.localeCompare(right.errorKey)
    ));
  const errorGroups = completeErrorGroups.slice(0, ERROR_GROUP_LIMIT);

  const latestRun = orderedRuns[0] ?? null;
  return {
    measureId: RUNTIME_HEALTH_MEASURE.id,
    measureVersion: RUNTIME_HEALTH_MEASURE.version,
    campaignId,
    workflowId,
    workflowRole: partition.workflowRole,
    workflowState: optionalString(partition.workflowState) ?? 'unknown',
    partitionKind: partition.workflowRole === 'orchestrator' ? 'orchestrator' : 'worker-target',
    ...(partition.workflowRole === 'worker' ? { targetRepositoryId, targetScopeMembership } : {}),
    answer,
    needsAttention: ATTENTION_ANSWERS.has(answer),
    evidenceQuality: partition.evidenceQuality ?? null,
    latestRun: latestRun ? runReference(latestRun) : null,
    latestSuccess: latestSuccess ? runReference(latestSuccess) : null,
    successBoundary: latestSuccess ? 'observed' : 'not-observed',
    runsSinceSuccess: runsSinceSuccess.length,
    terminalNonSuccessesSinceSuccess: terminalNonSuccesses.length,
    activeRunsSinceSuccess: activeRuns.length,
    unknownDateRunCount: unknownDateRuns.length,
    unknownDateRunReferences: unknownDateRuns.slice(0, RUN_REFERENCE_LIMIT).map(runReference),
    omittedUnknownDateRunReferenceCount: Math.max(0, unknownDateRuns.length - RUN_REFERENCE_LIMIT),
    recoveryMayBeInProgress: terminalNonSuccesses.length > 0 && activeRuns.length > 0,
    recordsVisited,
    partitionRunCount: partition.runs.length,
    errorGroupCount: completeErrorGroups.length,
    errorGroups,
    omittedErrorGroupCount: Math.max(0, completeErrorGroups.length - ERROR_GROUP_LIMIT),
    errorGroupLimit: ERROR_GROUP_LIMIT
  };
}

/** @param {ReturnType<typeof evaluateRuntimeHealthPartition>[]} orchestratorResults */
export function workerEvaluationState(orchestratorResults) {
  if (!Array.isArray(orchestratorResults) || orchestratorResults.length === 0) {
    return 'indeterminate-orchestrator';
  }
  const answers = new Set(orchestratorResults.map((result) => result.answer));
  if (answers.has('no')) return 'blocked-by-orchestrator';
  if (answers.has('unknown') || answers.has('not-observed')) return 'indeterminate-orchestrator';
  return 'eligible';
}

/** @param {ReturnType<typeof evaluateRuntimeHealthPartition>[]} results */
function aggregateAnswer(results) {
  const answers = new Set(results.map((result) => result.answer));
  if (answers.has('no')) return 'no';
  if (answers.has('unknown')) return 'unknown';
  if (answers.size === 1 && answers.has('not-observed')) return 'not-observed';
  if (answers.has('not-observed')) return 'unknown';
  if (answers.has('running')) return 'running';
  if (answers.size === 1 && answers.has('yes')) return 'yes';
  return 'unknown';
}

/**
 * @param {{
 *   campaignId: string,
 *   orchestratorPartitions: Parameters<typeof evaluateRuntimeHealthPartition>[0][],
 *   workerPartitions?: Parameters<typeof evaluateRuntimeHealthPartition>[0][]
 * }} campaign
 */
export function computeRuntimeHealthCampaign(campaign) {
  const campaignId = requiredString(campaign?.campaignId, 'campaign.campaignId');
  if (!Array.isArray(campaign.orchestratorPartitions)) {
    throw new TypeError('campaign.orchestratorPartitions must be an array');
  }
  if (campaign.workerPartitions !== undefined && !Array.isArray(campaign.workerPartitions)) {
    throw new TypeError('campaign.workerPartitions must be an array');
  }

  const orchestratorResults = campaign.orchestratorPartitions.map(evaluateRuntimeHealthPartition);
  const gate = workerEvaluationState(orchestratorResults);
  const workerResults = gate === 'eligible'
    ? (campaign.workerPartitions ?? []).map(evaluateRuntimeHealthPartition)
    : [];
  const includedWorkers = workerResults.filter((result) => (
    result.targetScopeMembership !== 'observed-extra'
  ));
  const includedResults = [...orchestratorResults, ...includedWorkers];
  const answer = gate === 'blocked-by-orchestrator'
    ? 'no'
    : gate === 'indeterminate-orchestrator'
      ? 'unknown'
      : aggregateAnswer(includedResults);
  const partitionResults = [...orchestratorResults, ...workerResults];

  return {
    campaignResult: {
      measureId: RUNTIME_HEALTH_MEASURE.id,
      measureVersion: RUNTIME_HEALTH_MEASURE.version,
      campaignId,
      answer,
      workerEvaluationState: gate,
      orchestratorCount: orchestratorResults.length,
      workerPartitionCount: workerResults.length,
      attentionPartitionCount: includedResults.filter((result) => result.needsAttention).length,
      recordsVisited: partitionResults.reduce((total, result) => total + result.recordsVisited, 0),
      partitionRunCount: partitionResults.reduce((total, result) => total + result.partitionRunCount, 0),
      skippedWorkerPartitionCount: gate === 'eligible' ? 0 : campaign.workerPartitions?.length ?? 0,
      skippedWorkerRunCount: gate === 'eligible'
        ? 0
        : (campaign.workerPartitions ?? []).reduce((total, partition) => total + partition.runs.length, 0)
    },
    partitionResults,
    errorGroups: partitionResults.flatMap((result) => result.errorGroups.map((group) => ({
      campaignId,
      workflowId: result.workflowId,
      workflowRole: result.workflowRole,
      targetRepositoryId: result.targetRepositoryId,
      targetScopeMembership: result.targetScopeMembership,
      ...group
    })))
  };
}

/**
 * @param {{ campaigns: Parameters<typeof computeRuntimeHealthCampaign>[0][] }} input
 */
export function computeRuntimeHealthPortfolio(input) {
  if (!Array.isArray(input?.campaigns)) throw new TypeError('input.campaigns must be an array');
  const campaignComputations = [...input.campaigns]
    .sort((left, right) => String(left.campaignId).localeCompare(String(right.campaignId)))
    .map(computeRuntimeHealthCampaign);
  return {
    measureId: RUNTIME_HEALTH_MEASURE.id,
    measureVersion: RUNTIME_HEALTH_MEASURE.version,
    campaignResults: campaignComputations.map(({ campaignResult }) => campaignResult),
    partitionResults: campaignComputations.flatMap(({ partitionResults }) => partitionResults),
    errorGroups: campaignComputations.flatMap(({ errorGroups }) => errorGroups)
  };
}
