import { canonicalTimestamp, relationshipErrors } from './schema.js';
import { discardAudit } from './audit-curation.js';

export const AUDIT_PROJECTION_VERSION = 1;

/** @param {unknown} value */
export function validateAuditProjectionReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.get(value, 'version') !== AUDIT_PROJECTION_VERSION) {
    throw new TypeError('Normalized activity requires the current information projection');
  }
  const input = Reflect.get(value, 'inputAudits');
  const represented = Reflect.get(value, 'representedAudits');
  const residual = Reflect.get(value, 'residualAudits');
  if (![input, represented, residual].every((count) => Number.isSafeInteger(count) && count >= 0)
      || input - represented !== residual) {
    throw new TypeError('Information projection Audit counts are invalid');
  }
  const clock = Reflect.get(value, 'sourceClock');
  if (clock !== null && !validInstant(clock)) {
    throw new TypeError('Information projection source clock is invalid');
  }
  return { sourceClock: /** @type {string | null} */ (clock) };
}
export const AUDIT_PROJECTION_EVIDENCE_FIELDS = Object.freeze([
  'originId', 'source', 'status', 'timestamp', 'observedAt', 'sequence',
  'sourceSequence', 'payloadRef', 'attempt', 'provenanceSource',
  'provenanceSourceId', 'provenanceObservedAt', 'templateVersion'
]);
export const TASK_DOMAIN_LABELS = Object.freeze([
  'Code Fix', 'Research', 'General Automation', 'Release / Ops', 'Triage', 'Issue Response'
]);
const SHARED = new Set([
  'id', 'runId', 'source', 'type', 'status', 'summary', 'timestamp', 'observedAt',
  'sequence', 'sourceSequence', 'payloadRef', 'provenance', 'attempt'
]);
const RESULT_FIELDS = new Map([
  ['graderName', 'observedName'], ['unit', 'observedUnit'], ['direction', 'observedDirection'],
  ['graderSource', 'graderSource'], ['message', 'message'], ['error', 'error'],
  ['baselineValue', 'baselineValue'], ['deltaFromBaseline', 'deltaFromBaseline']
]);
export const AUDIT_TEMPLATES = Object.freeze({
  recommendationReviewErrors: 'Review error logs to identify root cause of failure',
  recommendationTrimExecution: 'Compare this run to similar successful runs and trim unnecessary turns, tools, or write actions.',
  recommendationSmallerModel: 'Try engine.model: gpt-4.1-mini or claude-haiku-4-5 in the workflow frontmatter.',
  recommendationAllowDomains: 'Add blocked domains to the workflow network allow-list',
  recommendationDeterministic: 'Consider whether a scripted rule or deterministic workflow step could replace this agentic path.',
  recommendationStrongerEvidence: 'Tighten instructions, reduce unnecessary tools, or delay write actions until the workflow has stronger evidence.',
  recommendationMonitor: 'Monitor workflow performance over time',
  observabilityNetworkFriction: 'Network friction detected',
  observabilityExploratory: 'Exploratory execution path',
  observabilityAnomaly: '1 anomalous event pattern(s) detected'
});
export const RUN_AUDIT_EVIDENCE_FIELDS = Object.freeze([
  'behaviorEvidence', 'sessionEvidence', 'startedEvidence', 'completedEvidence',
  'failureEvidence', 'usageEvidence', 'safeOutputCountEvidence',
  'assessmentHeavyExecution', 'assessmentSmallerModel', 'assessmentDeterministic',
  ...Object.keys(AUDIT_TEMPLATES)
]);
const RUN_COPY_SLOTS = new Map([
  ['workflow_run_started', 'startedEvidence'], ['workflow_run_completed', 'completedEvidence'],
  ['workflow_run_failed', 'failureEvidence'], ['workflow_run_usage', 'usageEvidence'],
  ['workflow_run_safe_outputs', 'safeOutputCountEvidence']
]);
const OUTPUT_FIELDS = ['safeOutputId', 'safeOutputType', 'safeOutputUrl', 'githubEntityType', 'correlationId'];

/** @param {unknown} value */
function validInstant(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(day)
    && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** @param {Record<string, unknown>} audit */
function evidence(audit) {
  const provenance = audit.provenance;
  const fields = Object.fromEntries([
    ['originId', audit.id], ...['source', 'status', 'timestamp', 'observedAt',
      'sequence', 'sourceSequence', 'payloadRef', 'attempt'].map((field) => [field, audit[field]]),
    ['provenanceSource', provenance && typeof provenance === 'object' ? Reflect.get(provenance, 'source') : undefined],
    ['provenanceSourceId', provenance && typeof provenance === 'object' ? Reflect.get(provenance, 'sourceId') : undefined],
    ['provenanceObservedAt', provenance && typeof provenance === 'object' ? Reflect.get(provenance, 'observedAt') : undefined],
    ['templateVersion', AUDIT_PROJECTION_VERSION]
  ].filter(([, value]) => value !== undefined));
  return fields;
}

/** @param {Record<string, unknown>} audit @param {string[]} [extra] */
function supported(audit, extra = []) {
  return Object.keys(audit).every((field) => SHARED.has(field) || extra.includes(field))
    && (audit.provenance === undefined || (audit.provenance !== null && typeof audit.provenance === 'object'
      && !Array.isArray(audit.provenance)
      && Object.keys(audit.provenance).length > 0
      && Object.keys(audit.provenance).every((field) => ['source', 'sourceId', 'observedAt'].includes(field))));
}

/** @param {Record<string, unknown>} audit @param {Record<string, unknown>} run */
function applicable(audit, run) {
  return validInstant(audit.timestamp) && validInstant(audit.observedAt)
    && Number.isSafeInteger(audit.attempt) && Number(audit.attempt) > 0
    && audit.attempt === run.attempt
    && typeof audit.id === 'string' && audit.id.length > 0;
}

/** @param {Record<string, unknown>} audit */
function narrativeSlot(audit) {
  if (audit.source === 'audit') {
    for (const [slot, text] of Object.entries(AUDIT_TEMPLATES)) {
      const type = slot.startsWith('recommendation') ? 'audit.recommendation' : 'audit.observability';
      if (audit.type === type && audit.summary === text
          && ['low', 'medium', 'high'].includes(String(audit.status))) return { slot };
    }
  }
  if (audit.source !== 'gh-aw-logs' || audit.type !== 'workflow_run_assessment'
      || !['low', 'medium', 'high'].includes(String(audit.status))) return null;
  for (const label of TASK_DOMAIN_LABELS) {
    for (const [slot, text] of [
      ['assessmentHeavyExecution', `This ${label} run consumed a heavy execution profile for its task shape.`],
      ['assessmentSmallerModel', `This ${label} run may not need a frontier model. A smaller model (e.g. gpt-4.1-mini, claude-haiku-4-5) could handle the task at lower cost.`],
      ['assessmentDeterministic', `This ${label} run looks stable enough that deterministic automation may be a simpler fit.`]
    ]) if (audit.summary === text) return { slot, label };
  }
  return null;
}

/**
 * Projects one complete deduplicated incoming generation, never a write batch.
 * Original payloads are shared; only changed canonical owners are copied.
 * @param {import('./schema.js').CanonicalBatch} input
 * @param {{ validate?: boolean }} [options]
 */
export function projectAuditEvidence(input, options = {}) {
  const batch = { ...input };
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const graders = new Map((input.graders ?? []).map((grader) => [grader.id, grader]));
  const evals = new Map((input.evals ?? []).map((definition) => [definition.id, definition]));
  const results = new Map();
  const outputs = new Map();
  /** @type {Map<string, Record<string, unknown>[]>} */
  const issuesByAction = new Map();
  const actionCounts = new Map();
  const actionKey = (/** @type {Record<string, unknown>} */ record) =>
    `${String(record.runId)}\0${String(record.correlationId)}`;
  for (const issue of input.issues) {
    const key = actionKey(issue);
    const entries = issuesByAction.get(key) ?? [];
    entries.push(issue);
    issuesByAction.set(key, entries);
  }
  const references = new Map();
  for (const collection of ['graderObservations', 'evalObservations', 'experimentAssignments']) {
    for (const record of input[/** @type {'graderObservations'} */ (collection)] ?? []) {
      if (typeof record.auditId !== 'string') continue;
      const entries = references.get(record.auditId) ?? [];
      entries.push({ collection, record });
      references.set(record.auditId, entries);
    }
  }
  const slots = new Map();
  for (const audit of input.audits) {
    if (audit.type === 'safe_output.created') {
      const key = actionKey(audit);
      actionCounts.set(key, (actionCounts.get(key) ?? 0) + 1);
    }
    const slot = audit.type === 'workflow_run_behavior' ? 'behaviorEvidence'
      : audit.type === 'agent.session' ? 'sessionEvidence'
      : narrativeSlot(audit)?.slot ?? RUN_COPY_SLOTS.get(String(audit.type));
    if (!slot) continue;
    const key = `${String(audit.runId)}\0${slot}`;
    slots.set(key, (slots.get(key) ?? 0) + 1);
  }
  for (const audit of input.audits) {
    const run = runs.get(audit.runId);
    if (run && applicable(audit, run) && supported(audit)
        && audit.source === 'gh-aw-logs' && audit.type === 'workflow_run_behavior'
        && audit.status === 'observed' && TASK_DOMAIN_LABELS.includes(/** @type {string} */ (audit.summary))
        && slots.get(`${String(run.id)}\0behaviorEvidence`) === 1
        && !references.has(audit.id)
        && (run.behaviorEvidence === undefined
          || JSON.stringify(run.behaviorEvidence) === JSON.stringify(evidence(audit)))
        && (run.taskDomainLabel === undefined || run.taskDomainLabel === audit.summary)) {
      runs.set(run.id, { ...run, taskDomainLabel: audit.summary, behaviorEvidence: evidence(audit) });
    }
  }
  const receipt = {
    version: AUDIT_PROJECTION_VERSION, inputAudits: input.audits.length,
    representedAudits: 0, residualAudits: 0, sourceClock: /** @type {string | null} */ (null),
    families: /** @type {Record<string, number>} */ ({}),
    retainedReasons: /** @type {Record<string, number>} */ ({})
  };
  for (const records of Object.values(input)) for (const record of records ?? []) {
    for (const field of ['timestamp', 'observedAt', 'updatedAt', 'completedAt', 'startedAt', 'createdAt']) {
      if (!validInstant(record[field])) continue;
      const clock = canonicalTimestamp(record[field], field);
      if (receipt.sourceClock === null || clock > receipt.sourceClock) receipt.sourceClock = clock;
    }
  }
  batch.audits = input.audits.filter((audit) => {
    const retain = (/** @type {string} */ reason) => {
      receipt.retainedReasons[reason] = (receipt.retainedReasons[reason] ?? 0) + 1;
      return true;
    };
    const run = runs.get(audit.runId);
    if (!run || !applicable(audit, run)) return retain('owner-attempt-or-time');
    const linked = references.get(audit.id) ?? [];
    let absorbed = false;
    if (audit.type === 'workflow_run_grader' && audit.source === 'grader'
        && linked.length === 1 && linked[0].collection === 'graderObservations') {
      const result = linked[0].record;
      const definition = graders.get(result.graderId);
      if (!supported(audit, ['grader', 'value', ...RESULT_FIELDS.keys()])
          || result.runId !== run.id || definition?.workflowId !== run.workflowId
          || audit.grader !== definition?.sourceGraderId || audit.value !== result.value
          || audit.status !== result.status
          || audit.summary !== (audit.graderName ?? audit.grader)) return retain('non-equivalent-result');
      const overlay = { ...result };
      for (const [from, to] of RESULT_FIELDS) {
        if (!Object.hasOwn(audit, from)) continue;
        if (Object.hasOwn(result, to) && result[to] !== audit[from]) return retain('conflicting-result-attribute');
        overlay[to] = audit[from];
      }
      if (Object.hasOwn(result, 'auditEvidence')
          && JSON.stringify(result.auditEvidence) !== JSON.stringify(evidence(audit))) {
        return retain('conflicting-result-attribute');
      }
      overlay.auditEvidence = evidence(audit);
      delete overlay.auditId;
      results.set(`graderObservations\0${String(result.id)}`, overlay);
      absorbed = true;
    } else if (audit.type === 'workflow_run_eval' && audit.source === 'audit'
        && linked.length === 1 && linked[0].collection === 'evalObservations') {
      const result = linked[0].record;
      const definition = evals.get(result.evalId);
      if (!supported(audit, ['evidenceState', 'evalId', 'answer'])
          || audit.evidenceState !== 'classified' || result.runId !== run.id
          || definition?.workflowId !== run.workflowId || audit.evalId !== definition?.sourceEvalId
          || audit.answer !== result.evalResult || audit.status !== result.status
          || audit.summary !== `Evaluation ${String(audit.evalId)}`
          || !['YES', 'NO', 'UNKNOWN'].includes(String(result.evalResult))) return retain('non-equivalent-result');
      if (Object.hasOwn(result, 'auditEvidence')
          && JSON.stringify(result.auditEvidence) !== JSON.stringify(evidence(audit))) {
        return retain('conflicting-result-attribute');
      }
      const overlay = { ...result, auditEvidence: evidence(audit) };
      delete overlay.auditId;
      results.set(`evalObservations\0${String(result.id)}`, overlay);
      absorbed = true;
    } else if (audit.type === 'safe_output.created' && audit.source === 'safe-output'
        && linked.length === 0 && supported(audit, OUTPUT_FIELDS)) {
      const matches = (issuesByAction.get(actionKey(audit)) ?? []).filter((issue) => issue.runId === run.id
        && issue.type === audit.type && issue.source === audit.source
        && issue.timestamp === audit.timestamp && issue.status === audit.status
        && issue.summary === audit.summary && typeof audit.correlationId === 'string'
        && issue.correlationId === audit.correlationId
        && OUTPUT_FIELDS.every((field) => issue[field] === audit[field]));
      if (matches.length !== 1 || outputs.has(matches[0].id)
          || actionCounts.get(actionKey(audit)) !== 1) return retain('unrepresented-action-occurrence');
      if (Object.hasOwn(matches[0], 'auditEvidence')
          && JSON.stringify(matches[0].auditEvidence) !== JSON.stringify(evidence(audit))) {
        return retain('conflicting-owner-evidence');
      }
      outputs.set(matches[0].id, { ...matches[0], auditEvidence: evidence(audit) });
      absorbed = true;
    } else {
      if (linked.length > 0) return retain('unresolved-reference');
      if (!supported(audit)) return retain('independent-detail');
      let slot = RUN_COPY_SLOTS.get(String(audit.type));
      const overlay = { ...run };
      if (audit.type === 'workflow_run_behavior' && audit.source === 'gh-aw-logs'
          && audit.status === 'observed' && TASK_DOMAIN_LABELS.includes(/** @type {string} */ (audit.summary))) {
        if (run.taskDomainLabel !== undefined && run.taskDomainLabel !== audit.summary) return retain('conflicting-owner-attribute');
        slot = 'behaviorEvidence';
        overlay.taskDomainLabel = audit.summary;
      } else if (audit.type === 'agent.session' && audit.source === 'agent'
          && typeof audit.summary === 'string' && audit.summary.length <= 1024
          && audit.status === run.status) {
        if (run.sessionLabel !== undefined && run.sessionLabel !== audit.summary) return retain('conflicting-owner-attribute');
        slot = 'sessionEvidence';
        overlay.sessionLabel = audit.summary;
      } else {
        const narrative = narrativeSlot(audit);
        if (narrative) {
          slot = narrative.slot;
          if (narrative.label) {
            if (run.taskDomainLabel !== narrative.label) return retain('conflicting-owner-attribute');
          }
        } else if (!slot || !discardAudit(audit, run)
            || (audit.type === 'workflow_run_started' && audit.summary !== run.title)) return retain('unrepresented');
      }
      if (!slot || slots.get(`${String(run.id)}\0${slot}`) !== 1) return retain('multiple-occurrences');
      if (run[slot] !== undefined && JSON.stringify(run[slot]) !== JSON.stringify(evidence(audit))) return retain('conflicting-owner-evidence');
      overlay[slot] = evidence(audit);
      runs.set(run.id, overlay);
      absorbed = true;
    }
    if (!absorbed) return retain('unrepresented');
    receipt.representedAudits += 1;
    const family = String(audit.type);
    receipt.families[family] = (receipt.families[family] ?? 0) + 1;
    return false;
  });
  batch.runs = input.runs.map((run) => runs.get(run.id) ?? run);
  batch.graderObservations = (input.graderObservations ?? []).map((result) =>
    results.get(`graderObservations\0${String(result.id)}`) ?? result);
  batch.evalObservations = (input.evalObservations ?? []).map((result) =>
    results.get(`evalObservations\0${String(result.id)}`) ?? result);
  batch.issues = input.issues.map((issue) => outputs.get(issue.id) ?? issue);
  receipt.residualAudits = batch.audits.length;
  receipt.families = Object.fromEntries(Object.entries(receipt.families).sort(([a], [b]) => a.localeCompare(b)));
  receipt.retainedReasons = Object.fromEntries(Object.entries(receipt.retainedReasons).sort(([a], [b]) => a.localeCompare(b)));
  if (options.validate !== false) {
    const errors = relationshipErrors(batch);
    if (errors.length > 0) throw new TypeError(`Invalid projected evidence relationships: ${errors.join('; ')}`);
  }
  return { batch, receipt };
}
