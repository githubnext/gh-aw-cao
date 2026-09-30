import { createDebug } from '../../debug.js';

const debugSchema = createDebug('schema');

export const CANONICAL_SCHEMA_VERSION = 24;

export const ENTITY_KINDS = /** @type {const} */ ([
  'campaign',
  'repository',
  'workflow',
  'run',
  'domain',
  'tool',
  'skill',
  'friction',
  'audit',
  'issue',
  'operational-value',
  'marketplace-package',
  'experiment', 'experiment-assignment', 'grader', 'grader-observation', 'eval', 'eval-observation'
]);
export const EVIDENCE_DEFINITION_STORES = new Set(['experiments', 'graders', 'evals']);

/** @param {Record<string, unknown> | undefined} previous @param {Record<string, unknown>} incoming */
export function mergeEvidenceDefinition(previous, incoming) {
  if (!previous) return incoming;
  const before = String(previous.firstObservedAt ?? previous.observedAt ?? '');
  const after = String(incoming.firstObservedAt ?? incoming.observedAt ?? '');
  const previousLast = String(previous.lastObservedAt ?? previous.observedAt ?? '');
  const incomingLast = String(incoming.lastObservedAt ?? incoming.observedAt ?? '');
  return {
    ...(previousLast > incomingLast ? previous : incoming),
    firstObservedAt: [before, after].filter(Boolean).sort()[0],
    lastObservedAt: [previousLast, incomingLast].filter(Boolean).sort().at(-1)
  };
}
const RUN_LINKED_COLLECTIONS = /** @type {const} */ ([
  'domains',
  'tools',
  'skills',
  'friction',
  'audits',
  'issues'
]);

/** @typedef {typeof ENTITY_KINDS[number]} EntityKind */

/**
 * Source-neutral input emitted by adapters. Undefined data fields are ignored
 * during enrichment; null remains an explicit observed value.
 *
 * @typedef {object} CanonicalObservation
 * @property {EntityKind} kind
 * @property {string} source
 * @property {string} sourceId
 * @property {string} observedAt
 * @property {Record<string, unknown>} data
 */

/**
 * @typedef {object} CanonicalBatch
 * @property {Record<string, unknown>[]} campaigns
 * @property {Record<string, unknown>[]} repositories
 * @property {Record<string, unknown>[]} workflows
 * @property {Record<string, unknown>[]} runs
 * @property {Record<string, unknown>[]} domains
 * @property {Record<string, unknown>[]} tools
 * @property {Record<string, unknown>[]} skills
 * @property {Record<string, unknown>[]} friction
 * @property {Record<string, unknown>[]} audits
 * @property {Record<string, unknown>[]} issues
 * @property {Record<string, unknown>[]} operationalValues
 * @property {Record<string, unknown>[]} marketplacePackages
 * @property {Record<string, unknown>[]} [experiments]
 * @property {Record<string, unknown>[]} [experimentAssignments]
 * @property {Record<string, unknown>[]} [graders]
 * @property {Record<string, unknown>[]} [graderObservations]
 * @property {Record<string, unknown>[]} [evals]
 * @property {Record<string, unknown>[]} [evalObservations]
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function canonicalTimestamp(value, field) {
  const input = requiredString(value, field);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${field} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

/**
 * Reports mandatory relationship failures without preventing partial entities
 * from existing during normalization.
 *
 * @param {CanonicalBatch} batch
 * @returns {string[]}
 */
export function relationshipErrors(batch) {
  debugSchema({
    event: 'validation-start',
    workflowCount: batch.workflows.length,
    runCount: batch.runs.length
  });
  const campaignRecords = batch.campaigns ?? [];
  const campaignsById = new Map(campaignRecords.map((record) => [record.id, record]));
  const workflowsById = new Map(batch.workflows.map((record) => [record.id, record]));
  const ids = {
    repositories: new Set(batch.repositories.map((record) => record.id)),
    campaigns: new Set(campaignRecords.map((record) => record.id)),
    workflows: new Set(batch.workflows.map((record) => record.id)),
    runs: new Set(batch.runs.map((record) => record.id))
  };
  const entityNames = {
    repositories: 'repository',
    campaigns: 'campaign',
    workflows: 'workflow',
    runs: 'run'
  };
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {Record<string, unknown>} record
   * @param {string} field
   * @param {keyof typeof ids} collection
   */
  const requireReference = (record, field, collection) => {
    const id = String(record.id ?? '<unknown>');
    const reference = record[field];
    if (typeof reference !== 'string' || !reference || !ids[collection].has(reference)) {
      errors.push(`${id}.${field} does not reference an existing ${entityNames[collection]}`);
    }
  };

  for (const workflow of batch.workflows) {
    requireReference(workflow, 'repositoryId', 'repositories');
    if (workflow.campaignId !== undefined && workflow.campaignId !== null) {
      requireReference(workflow, 'campaignId', 'campaigns');
      const campaignRecord = campaignsById.get(workflow.campaignId);
      if (campaignRecord && workflow.campaign !== campaignRecord.slug) {
        errors.push(`${String(workflow.id ?? '<unknown>')}.campaignId references a different campaign slug`);
      }
    }
  }
  for (const run of batch.runs) {
    requireReference(run, 'repositoryId', 'repositories');
    requireReference(run, 'workflowId', 'workflows');
    const workflow = workflowsById.get(run.workflowId);
    if (workflow && workflow.repositoryId !== run.repositoryId) {
      errors.push(`${String(run.id ?? '<unknown>')}.workflowId references a workflow from another repository`);
    }
  }
  for (const collection of RUN_LINKED_COLLECTIONS) {
    for (const record of batch[collection] ?? []) {
      requireReference(record, 'runId', 'runs');
    }
  }
  for (const record of batch.operationalValues ?? []) {
    requireReference(record, 'repositoryId', 'repositories');
  }
  const experiments = new Map((batch.experiments ?? []).map((record) => [record.id, record]));
  const graders = new Map((batch.graders ?? []).map((record) => [record.id, record]));
  const evals = new Map((batch.evals ?? []).map((record) => [record.id, record]));
  const runsById = new Map(batch.runs.map((record) => [record.id, record]));
  for (const record of batch.experiments ?? []) requireReference(record, 'workflowId', 'workflows');
  for (const record of batch.graders ?? []) requireReference(record, 'workflowId', 'workflows');
  for (const record of batch.evals ?? []) requireReference(record, 'workflowId', 'workflows');
  for (const [collection, parentField, parents] of /** @type {[Record<string, unknown>[] | undefined, string, Map<unknown, Record<string, unknown>>][]} */ ([
    [batch.experimentAssignments, 'experimentId', experiments],
    [batch.graderObservations, 'graderId', graders],
    [batch.evalObservations, 'evalId', evals]
  ])) {
    for (const record of collection ?? []) {
      requireReference(record, 'runId', 'runs');
      if (!parents.has(record[parentField])) errors.push(`${String(record.id)}.${parentField} does not reference a definition`);
      const parent = parents.get(record[parentField]);
      const run = runsById.get(record.runId);
      if (parent && run && parent.workflowId !== run.workflowId) {
        errors.push(`${String(record.id)}.${parentField} references a different workflow`);
      }
    }
  }

  if (errors.length > 0) {
    debugSchema({ event: 'validation-failed', errorCount: errors.length });
  } else {
    debugSchema({ event: 'validation-passed' });
  }

  return errors;
}