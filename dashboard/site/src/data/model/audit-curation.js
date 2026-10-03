export const AUDIT_CURATION_VERSION = 1;
export const AUDIT_CURATION_TRANSACTION_ID = 'maintenance:audit-curation';

const SHARED_FIELDS = new Set([
  'id', 'runId', 'timestamp', 'source', 'type', 'summary', 'status',
  'observedAt', 'provenance', 'sequence', 'sourceSequence', 'payloadRef'
]);
const NUMBER = '(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:e[+-]?[0-9]{1,3})?';
const NUMERIC_SUMMARY_LIMIT = 1024;
const AIC_SUMMARY = new RegExp(`^AIC (${NUMBER})$`);
const COUNT_SUMMARY = /^(0|[1-9][0-9]*) safe output items$/;
const RUN_FIELDS = [
  'id', 'startedAt', 'createdAt', 'completedAt', 'status', 'conclusion',
  'classification', 'failureKind', 'aicTotal', 'safeItemsCount'
];

/** @param {Record<string, unknown>} run */
export function auditCurationRunFacts(run) {
  return Object.fromEntries(RUN_FIELDS.map((field) => [field, run[field]]));
}

/** @param {unknown} value */
function instant(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) && Number.isFinite(day)
    && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10)
    ? parsed : null;
}

/** @param {unknown} left @param {unknown} right */
function sameInstant(left, right) {
  const parsed = instant(left);
  return parsed !== null && parsed === instant(right);
}

/** @param {unknown} value */
function nonemptyText(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * First-pass policy shared by canonical normalization and persisted maintenance.
 * Missing comparison facts and additional evidence always retain the Audit.
 * @param {Record<string, unknown>} audit
 * @param {Record<string, unknown> | null | undefined} [run]
 * @returns {boolean}
 */
export function discardAudit(audit, run) {
  if (instant(audit.timestamp) === null) return false;
  if (Object.entries(audit).some(([field, value]) => value != null
      && !SHARED_FIELDS.has(field)
      && !(field === 'code' && audit.type === 'audit.finding' && value === 'workflow_failed'))) return false;
  const { source, type, status, summary } = audit;
  if (source === 'gh-aw-logs') {
    if (type === 'workflow_run_comparison' && status === 'unavailable' && summary === 'No baseline comparison') return true;
    if (type === 'workflow_run_working_set' && status === 'observed' && summary === 'Working set measured') return true;
  }
  if (source === 'agent' && type === 'agent.session' && status === 'completed' && summary === '') return true;
  if (source === 'audit' && status === 'low') {
    if (type === 'audit.observability' && summary === '1 anomalous event pattern(s) detected') return true;
    if (type === 'audit.recommendation' && summary === 'Monitor workflow performance over time') return true;
  }
  if (!run || run.id !== audit.runId) return false;
  if (source === 'audit') {
    return type === 'audit.finding' && status === 'critical' && summary === 'Workflow Failed'
      && audit.code === 'workflow_failed' && run.conclusion === 'failure';
  }
  if (source !== 'gh-aw-logs') return false;
  switch (type) {
    case 'workflow_run_started':
      return nonemptyText(status) !== null && status === run.status
        && sameInstant(audit.timestamp, run.startedAt ?? run.createdAt);
    case 'workflow_run_completed':
      return nonemptyText(status) !== null && status === run.conclusion
        && summary === (nonemptyText(run.classification) ?? nonemptyText(run.conclusion))
        && sameInstant(audit.timestamp, run.completedAt);
    case 'workflow_run_failed':
      return status === 'failure' && (run.conclusion === 'failure' || nonemptyText(run.failureKind) !== null)
        && summary === (nonemptyText(run.failureKind) ?? 'workflow run failed');
    case 'workflow_run_usage': {
      const match = typeof summary === 'string' && summary.length <= NUMERIC_SUMMARY_LIMIT
        ? AIC_SUMMARY.exec(summary) : null;
      const value = match ? Number(match[1]) : NaN;
      return status === 'observed' && typeof run.aicTotal === 'number'
        && match?.[0] === summary
        && Number.isFinite(run.aicTotal) && Number.isFinite(value) && value >= 0
        && value === run.aicTotal;
    }
    case 'workflow_run_safe_outputs': {
      const match = typeof summary === 'string' && summary.length <= NUMERIC_SUMMARY_LIMIT
        ? COUNT_SUMMARY.exec(summary) : null;
      const value = match ? Number(match[1]) : NaN;
      return status === 'observed' && Number.isSafeInteger(value) && value >= 0
        && match?.[0] === summary
        && Number.isSafeInteger(run.safeItemsCount) && value === run.safeItemsCount;
    }
    default:
      return false;
  }
}

/** @param {import('./schema.js').CanonicalBatch} batch */
export function curateBatchAudits(batch) {
  const runs = new Map(batch.runs.map((run) => [run.id, run]));
  const referenced = new Set([
    ...batch.graderObservations ?? [], ...batch.evalObservations ?? [], ...batch.experimentAssignments ?? []
  ].map((observation) => observation.auditId).filter((id) => typeof id === 'string'));
  return batch.audits.filter((audit) =>
    (typeof audit.id === 'string' && referenced.has(audit.id)) || !discardAudit(audit, runs.get(audit.runId)));
}
