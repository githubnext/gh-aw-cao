export const CANONICAL_SCHEMA_VERSION = 12;

export const ENTITY_KINDS = /** @type {const} */ ([
  'campaign',
  'repository',
  'workflow',
  'run',
  'domain',
  'tool',
  'audit',
  'issue'
]);
const RUN_LINKED_COLLECTIONS = /** @type {const} */ (['domains', 'tools', 'audits', 'issues']);

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
 * @property {Record<string, unknown>[]} audits
 * @property {Record<string, unknown>[]} issues
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
    for (const record of batch[collection]) {
      requireReference(record, 'runId', 'runs');
    }
  }

  return errors;
}