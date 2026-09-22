export const HOW_WELL_DOES_IT_RUN_MEASURE = Object.freeze({
  id: 'how-well-does-it-run',
  version: '1.0.0'
});

const OUTPUT_REFERENCE_LIMIT = 20;
const RUN_REFERENCE_LIMIT = 20;

/** @param {unknown} value @param {string} field */
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

/** @param {unknown} value */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function optionalString(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[midpoint]
    : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

/** @param {Record<string, unknown>} output */
function outputIdentity(output) {
  return optionalString(output.correlationId)
    ?? optionalString(output.url)
    ?? optionalString(output.id)
    ?? optionalString(output.summary);
}

/** @param {Record<string, unknown>} output */
function outputReference(output) {
  return {
    id: outputIdentity(output),
    type: optionalString(output.safeOutputType)
      ?? optionalString(output.githubEntityType)
      ?? 'unknown',
    status: optionalString(output.status) ?? 'unknown',
    url: optionalString(output.url),
    observedAt: optionalString(output.observedAt) ?? optionalString(output.timestamp)
  };
}

/** @param {Record<string, unknown>} run */
function runReference(run) {
  return {
    runId: requiredString(run.id, 'run.id'),
    githubRunId: run.githubRunId,
    observedAt: optionalString(run.observedAt),
    runLink: optionalString(run.runLink)
  };
}

/**
 * Evaluates successful Runs already selected for one Campaign, Workflow, and
 * target Repository partition. Selection, joins, and ordering remain query
 * engine responsibilities.
 *
 * @param {{
 *   campaignId: string,
 *   workflowId: string,
 *   workflowRole: 'orchestrator'|'worker',
 *   targetRepositoryId?: string|null,
 *   targetScopeMembership?: 'expected'|'observed-extra'|'unknown'|null,
 *   runtimeAnswer: 'yes'|'running',
 *   evidenceWindowStart: string,
 *   evidenceWindowEnd: string,
 *   successfulRuns: Array<Record<string, unknown> & {
 *     outputs?: Record<string, unknown>[],
 *     operationalValueResults?: Record<string, unknown>[]
 *   }>
 * }} partition
 */
export function evaluateHowWellPartition(partition) {
  const campaignId = requiredString(partition?.campaignId, 'partition.campaignId');
  const workflowId = requiredString(partition?.workflowId, 'partition.workflowId');
  if (!['orchestrator', 'worker'].includes(partition?.workflowRole)) {
    throw new TypeError('partition.workflowRole must be orchestrator or worker');
  }
  if (!['yes', 'running'].includes(partition.runtimeAnswer)) {
    throw new TypeError('partition.runtimeAnswer must be yes or running');
  }
  if (!Array.isArray(partition.successfulRuns)) {
    throw new TypeError('partition.successfulRuns must be an array');
  }
  const evidenceWindowStart = requiredString(partition.evidenceWindowStart, 'partition.evidenceWindowStart');
  const evidenceWindowEnd = requiredString(partition.evidenceWindowEnd, 'partition.evidenceWindowEnd');

  const uniqueOutputs = new Map();
  const runsWithOutputs = new Set();
  const outputEvidenceKnownRuns = [];
  /** @type {{ run: Record<string, unknown>, result: Record<string, unknown> }[]} */
  const operationalResults = [];
  const aicValues = [];
  const durationValues = [];
  let producerReportedOutputCount = 0;
  for (const run of partition.successfulRuns) {
    if (run.conclusion !== 'success') {
      throw new TypeError('partition.successfulRuns may contain only successful Runs');
    }
    if (Number.isInteger(run.safeItemsCount) || Array.isArray(run.outputs)) {
      outputEvidenceKnownRuns.push(run);
    }
    if (Number.isInteger(run.safeItemsCount) && Number(run.safeItemsCount) >= 0) {
      producerReportedOutputCount += Number(run.safeItemsCount);
    }
    for (const output of run.outputs ?? []) {
      const identity = outputIdentity(output);
      if (!identity) continue;
      const key = `${requiredString(run.id, 'run.id')}:${identity}`;
      const previous = uniqueOutputs.get(key);
      const observedAt = optionalString(output.observedAt) ?? optionalString(output.timestamp) ?? '';
      const previousObservedAt = previous
        ? optionalString(previous.observedAt) ?? optionalString(previous.timestamp) ?? ''
        : '';
      if (!previous || observedAt > previousObservedAt) uniqueOutputs.set(key, output);
      runsWithOutputs.add(requiredString(run.id, 'run.id'));
    }
    for (const result of run.operationalValueResults ?? []) {
      operationalResults.push({ run, result });
    }
    const aic = finiteNumber(run.aic);
    if (aic !== null) aicValues.push(aic);
    const duration = finiteNumber(run.durationSeconds);
    if (duration !== null) durationValues.push(duration);
  }

  const outputs = [...uniqueOutputs.values()].map(outputReference);
  const outputKinds = Object.fromEntries([...new Set(outputs.map((output) => output.type))]
    .sort()
    .map((type) => [type, outputs.filter((output) => output.type === type).length]));
  const graderStatuses = Object.fromEntries(['pass', 'error', 'unavailable', 'fail']
    .map((status) => [
      status,
      operationalResults.filter(({ result }) => result.status === status).length
    ]));
  const measuredValues = operationalResults.flatMap(({ run, result }) => {
    const value = finiteNumber(result.value);
    if (result.status !== 'pass' || value === null) return [];
    return [{
      runId: requiredString(run.id, 'run.id'),
      value,
      unit: optionalString(result.unit),
      direction: optionalString(result.direction)
    }];
  });

  let productionState;
  if (outputs.length > 0 || producerReportedOutputCount > 0) productionState = 'produced';
  else if (partition.successfulRuns.length > 0
      && outputEvidenceKnownRuns.length === partition.successfulRuns.length) {
    productionState = 'none-observed';
  } else productionState = 'unknown';

  let valueMeasurementState;
  if (measuredValues.length > 0) valueMeasurementState = 'measured';
  else if (graderStatuses.error > 0) valueMeasurementState = 'evaluation-error';
  else if (graderStatuses.unavailable > 0) valueMeasurementState = 'unavailable';
  else valueMeasurementState = 'not-configured';

  return {
    measureId: HOW_WELL_DOES_IT_RUN_MEASURE.id,
    measureVersion: HOW_WELL_DOES_IT_RUN_MEASURE.version,
    campaignId,
    workflowId,
    workflowRole: partition.workflowRole,
    runtimeAnswer: partition.runtimeAnswer,
    ...(partition.workflowRole === 'worker' ? {
      targetRepositoryId: optionalString(partition.targetRepositoryId),
      targetScopeMembership: optionalString(partition.targetScopeMembership) ?? 'unknown'
    } : {}),
    evidenceWindowStart,
    evidenceWindowEnd,
    successfulRunCount: partition.successfulRuns.length,
    productionState,
    outputEvidenceCoverage: partition.successfulRuns.length === 0
      ? null
      : outputEvidenceKnownRuns.length / partition.successfulRuns.length,
    runsWithProducedOutputs: runsWithOutputs.size,
    producerReportedOutputCount,
    distinctOutputCount: outputs.length,
    outputKinds,
    outputReferences: outputs.slice(0, OUTPUT_REFERENCE_LIMIT),
    omittedOutputReferenceCount: Math.max(0, outputs.length - OUTPUT_REFERENCE_LIMIT),
    valueMeasurementState,
    operationalValueResultCount: operationalResults.length,
    operationalValueStatusCounts: graderStatuses,
    measuredOperationalValues: measuredValues.slice(0, RUN_REFERENCE_LIMIT),
    omittedMeasuredOperationalValueCount: Math.max(0, measuredValues.length - RUN_REFERENCE_LIMIT),
    efficiencyState: aicValues.length > 0 || durationValues.length > 0 ? 'measured' : 'unknown',
    aic: {
      measuredRunCount: aicValues.length,
      total: aicValues.length > 0 ? aicValues.reduce((total, value) => total + value, 0) : null,
      median: median(aicValues)
    },
    durationSeconds: {
      measuredRunCount: durationValues.length,
      total: durationValues.length > 0
        ? durationValues.reduce((total, value) => total + value, 0)
        : null,
      median: median(durationValues)
    },
    runReferences: partition.successfulRuns.slice(0, RUN_REFERENCE_LIMIT).map(runReference),
    omittedRunReferenceCount: Math.max(0, partition.successfulRuns.length - RUN_REFERENCE_LIMIT)
  };
}

/** @param {{ partitions: Parameters<typeof evaluateHowWellPartition>[0][] }} input */
export function computeHowWellPortfolio(input) {
  if (!Array.isArray(input?.partitions)) throw new TypeError('input.partitions must be an array');
  const partitionResults = input.partitions.map(evaluateHowWellPartition);
  return {
    measureId: HOW_WELL_DOES_IT_RUN_MEASURE.id,
    measureVersion: HOW_WELL_DOES_IT_RUN_MEASURE.version,
    partitionResults,
    totals: {
      partitionCount: partitionResults.length,
      successfulRunCount: partitionResults.reduce((total, result) => total + result.successfulRunCount, 0),
      distinctOutputCount: partitionResults.reduce((total, result) => total + result.distinctOutputCount, 0),
      measuredOperationalValueCount: partitionResults.reduce(
        (total, result) => total + result.measuredOperationalValues.length
          + result.omittedMeasuredOperationalValueCount,
        0
      )
    }
  };
}
