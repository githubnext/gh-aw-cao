import { canonicalJson, compareCanonicalStrings } from '../normalize/order.js';
import {
  compareRunPrecedence, logicalWatermark, metricWeekCutoff,
  normalizedRunPrecedence, runEventTime, tierIdentifier
} from './tiering.js';

const MAX_SCOPE_SHARDS = 4096;
const MAX_SHARD_RUNS = 1000;
const MAX_SCOPE_RUNS = 100_000;
const ADDITIVE_FIELDS = /** @type {const} */ ([
  'aicTotal', 'inputTokens', 'outputTokens'
]);

/**
 * @typedef {{ count: number, sum: number, exactSum: string }} MeasuredSum
 * @typedef {{
 *   runs: number,
 *   conclusions: Record<string, number>,
 *   aicTotal: MeasuredSum,
 *   inputTokens: MeasuredSum,
 *   outputTokens: MeasuredSum
 * }} DailyMeasures
 * @typedef {{
 *   namespace: string, day: string, repositoryId: string, workflowId: string,
 *   measures: DailyMeasures
 * }} DailyMetric
 * @typedef {{
 *   id: string, partition: string, metric: DailyMetric,
 *   precedence: ReturnType<typeof normalizedRunPrecedence>, retiredAt: number | null
 * }} RunContribution
 * @typedef {{
 *   version: 1, namespace: string, watermark: number,
 *   sourcePrecedence: Record<string, number>,
 *   contributions: Record<string, RunContribution>,
 *   dailyMetrics: Record<string, DailyMetric>,
 *   checkpoint: null | { scopeId: string, watermark: number, shards: string[] }
 * }} MetricLedger
 * @typedef {{
 *   id: string, namespace: string, watermark: number,
 *   expectedShards: string[], shards: Record<string, Record<string, unknown>[]>
 * }} MetricScope
 */

/** @param {string} namespace @param {number} watermark @param {Record<string, number>} [sourcePrecedence] @returns {MetricLedger} */
export function createMetricLedger(namespace, watermark, sourcePrecedence = {}) {
  if (Object.values(sourcePrecedence).some((rank) => !Number.isFinite(rank))) {
    throw new TypeError('Source precedence must be finite');
  }
  return {
    version: 1, namespace: tierIdentifier(namespace, 'namespace'),
    watermark: logicalWatermark(watermark), sourcePrecedence: { ...sourcePrecedence },
    contributions: {}, dailyMetrics: {}, checkpoint: null
  };
}

/**
 * Scopes contain only explicitly declared immutable shard identities. A caller
 * persists the returned staging state, not partial aggregate results.
 * @param {{ id: string, namespace: string, watermark: number, expectedShards: string[] }} options
 * @returns {MetricScope}
 */
export function beginMetricScope(options) {
  const expectedShards = [...options.expectedShards].sort(compareCanonicalStrings);
  if (expectedShards.length === 0) throw new TypeError('A scope requires at least one expected shard identity');
  if (expectedShards.length > MAX_SCOPE_SHARDS
    || new Set(expectedShards).size !== expectedShards.length) {
    throw new TypeError('A scope requires unique, bounded expected shard identities');
  }
  expectedShards.forEach((id) => tierIdentifier(id, 'shard identity'));
  return {
    id: tierIdentifier(options.id, 'scope.id'), namespace: tierIdentifier(options.namespace, 'namespace'),
    watermark: logicalWatermark(options.watermark), expectedShards, shards: {}
  };
}

/**
 * @param {MetricScope} scope
 * @param {string} shardId
 * @param {Record<string, unknown>[]} runs
 * @returns {MetricScope}
 */
export function stageMetricShard(scope, shardId, runs) {
  if (!scope.expectedShards.includes(shardId)) throw new TypeError('Undeclared metric shard');
  if (runs.length > MAX_SHARD_RUNS) throw new RangeError('Metric shard exceeds bounded run count');
  const key = canonicalJson([shardId]);
  const ordered = structuredClone(runs).sort((left, right) =>
    compareCanonicalStrings(canonicalJson(left), canonicalJson(right)));
  const previous = scope.shards[key];
  if (previous) {
    if (canonicalJson(previous) !== canonicalJson(ordered)) throw new Error('Metric shard identity changed content');
    return scope;
  }
  const stagedRuns = Object.values(scope.shards).reduce((sum, records) => sum + records.length, 0);
  if (stagedRuns + runs.length > MAX_SCOPE_RUNS) {
    throw new RangeError('Metric scope exceeds bounded run count');
  }
  return { ...scope, shards: { ...scope.shards, [key]: ordered } };
}

/** @returns {DailyMeasures} */
function emptyMeasures() {
  return {
    runs: 0, conclusions: {},
    aicTotal: { count: 0, sum: 0, exactSum: '0' },
    inputTokens: { count: 0, sum: 0, exactSum: '0' },
    outputTokens: { count: 0, sum: 0, exactSum: '0' }
  };
}

/** @param {string} value */
function decimalParts(value) {
  const [significand, exponent = '0'] = value.toLowerCase().split('e');
  const [whole, fraction = ''] = significand.split('.');
  const scale = fraction.length - Number(exponent);
  const coefficient = BigInt(whole + fraction);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

/**
 * Accumulate decimal representations exactly, rounding only the public numeric
 * sum. Float add/subtract otherwise makes replay order affect corrected totals.
 * @param {string} left @param {string} right @param {1 | -1} direction
 */
function addDecimal(left, right, direction) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const total = a.coefficient * 10n ** BigInt(scale - a.scale)
    + BigInt(direction) * b.coefficient * 10n ** BigInt(scale - b.scale);
  const sign = total < 0n ? '-' : '';
  const digits = String(total < 0n ? -total : total).padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
  return total === 0n ? '0' : sign + text;
}

/**
 * @param {string} namespace
 * @param {Record<string, unknown>} record
 * @param {Record<string, number>} sourcePrecedence
 * @returns {RunContribution}
 */
function contribution(namespace, record, sourcePrecedence) {
  const id = tierIdentifier(record.id, 'run.id');
  const day = new Date(runEventTime(record)).toISOString().slice(0, 10);
  const repositoryId = tierIdentifier(record.repositoryId, 'run.repositoryId');
  const workflowId = tierIdentifier(record.workflowId, 'run.workflowId');
  const measures = emptyMeasures();
  measures.runs = 1;
  const conclusion = record.conclusion == null ? 'unknown' : tierIdentifier(record.conclusion, 'run.conclusion');
  measures.conclusions = { [conclusion]: 1 };
  for (const field of ADDITIVE_FIELDS) {
    const value = record[field];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${field} must be a finite non-negative measurement`);
    }
    measures[field] = { count: 1, sum: value, exactSum: addDecimal('0', String(value), 1) };
  }
  return {
    id, partition: canonicalJson([namespace, day, repositoryId, workflowId]),
    metric: { namespace, day, repositoryId, workflowId, measures },
    precedence: normalizedRunPrecedence(record, sourcePrecedence), retiredAt: null
  };
}

/**
 * @param {Record<string, DailyMetric>} metrics
 * @param {RunContribution} value
 * @param {1 | -1} direction
 */
function applyContribution(metrics, value, direction) {
  const metric = metrics[value.partition] ?? structuredClone({
    ...value.metric, measures: emptyMeasures()
  });
  const target = metric.measures;
  const source = value.metric.measures;
  target.runs += direction;
  for (const [key, count] of Object.entries(source.conclusions)) {
    const total = (Object.hasOwn(target.conclusions, key) ? target.conclusions[key] : 0) + direction * count;
    if (total === 0) delete target.conclusions[key];
    else target.conclusions = { ...target.conclusions, [key]: total };
  }
  for (const field of ADDITIVE_FIELDS) {
    target[field].count += direction * source[field].count;
    target[field].exactSum = addDecimal(target[field].exactSum, source[field].exactSum, direction);
    target[field].sum = Number(target[field].exactSum);
    if (target[field].count < 0 || (target[field].count === 0 && target[field].sum !== 0)) {
      throw new Error('Daily metric ledger has inconsistent measurement counts');
    }
    if (!Number.isFinite(target[field].sum)) throw new RangeError('Daily metric sum overflow');
  }
  if (target.runs < 0) throw new Error('Daily metric ledger has a negative run count');
  if (target.runs === 0) delete metrics[value.partition];
  else metrics[value.partition] = metric;
}

/**
 * Produces an atomic commit candidate; it does NOT perform a storage commit.
 * Adapters must atomically persist contributions, metrics, and checkpoint, and
 * only then discard staged shards. Absent rows never imply deletion in a partial
 * collection. Each supplied row must already be a reconciled, complete canonical
 * Run snapshot: a newer snapshot replaces the entire old contribution, so an
 * omitted measurement becomes unknown. This reducer does not reconcile partial
 * evidence/enrichment patches. A rejected candidate leaves both inputs unchanged.
 *
 * @param {MetricLedger} state
 * @param {MetricScope} scope
 * @returns {MetricLedger}
 */
export function completeMetricScope(state, scope) {
  if (scope.namespace !== state.namespace) throw new Error('Metric scope namespace mismatch');
  if (logicalWatermark(scope.watermark) < state.watermark) throw new Error('Logical watermark cannot move backwards');
  if (scope.expectedShards.some((id) => !Object.hasOwn(scope.shards, canonicalJson([id])))) {
    throw new Error('Metric scope is incomplete');
  }
  /** @type {Map<string, RunContribution>} */
  const winners = new Map();
  for (const shardId of scope.expectedShards) {
    for (const record of scope.shards[canonicalJson([shardId])]) {
      if (runEventTime(record) > scope.watermark) throw new Error('Metric scope contains a future run');
      const value = contribution(state.namespace, record, state.sourcePrecedence);
      const previous = winners.get(value.id);
      if (!previous || compareRunPrecedence(previous.precedence, value.precedence) < 0) winners.set(value.id, value);
    }
  }
  const next = structuredClone(state);
  const cutoffTime = metricWeekCutoff(scope.watermark);
  const cutoff = new Date(cutoffTime).toISOString().slice(0, 10);
  for (const [key, metric] of Object.entries(next.dailyMetrics)) {
    if (metric.day < cutoff) delete next.dailyMetrics[key];
  }
  for (const [key, value] of Object.entries(next.contributions)) {
    if (value.retiredAt !== null && value.retiredAt < cutoffTime) delete next.contributions[key];
    else if (value.metric.day < cutoff && value.retiredAt === null) value.retiredAt = scope.watermark;
  }
  const replacements = [...winners.values()]
    .sort((left, right) => compareCanonicalStrings(left.id, right.id))
    .filter((value) => {
      const previous = next.contributions[canonicalJson([value.id])];
      return !previous || compareRunPrecedence(previous.precedence, value.precedence) < 0;
    });
  // Remove all superseded values first so valid corrections cannot transiently overflow.
  for (const value of replacements) {
    const previous = next.contributions[canonicalJson([value.id])];
    if (previous && previous.retiredAt === null) applyContribution(next.dailyMetrics, previous, -1);
  }
  for (const value of replacements) {
    const key = canonicalJson([value.id]);
    if (value.metric.day >= cutoff) {
      applyContribution(next.dailyMetrics, value, 1);
      next.contributions[key] = value;
    } else {
      next.contributions[key] = { ...value, retiredAt: scope.watermark };
    }
  }
  next.watermark = scope.watermark;
  next.checkpoint = { scopeId: scope.id, watermark: scope.watermark, shards: [...scope.expectedShards] };
  return next;
}
