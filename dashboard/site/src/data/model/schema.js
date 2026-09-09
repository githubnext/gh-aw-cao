export const CANONICAL_SCHEMA_VERSION = 4;

export const ENTITY_KINDS = /** @type {const} */ ([
  'repository',
  'workflow',
  'run',
  'job',
  'session',
  'event'
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
 * @property {Record<string, unknown>[]} repositories
 * @property {Record<string, unknown>[]} workflows
 * @property {Record<string, unknown>[]} runs
 * @property {Record<string, unknown>[]} jobs
 * @property {Record<string, unknown>[]} sessions
 * @property {Record<string, unknown>[]} events
 * @property {Record<string, unknown>[]} sourceMetadata
 * @property {Record<string, unknown>[]} sourceRecords
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
 * from existing during normalization. Generation validation can require this
 * list to be empty before activation.
 *
 * @param {CanonicalBatch} batch
 * @returns {string[]}
 */
export function relationshipErrors(batch) {
  const ids = {
    repositories: new Set(batch.repositories.map((record) => record.id)),
    workflows: new Set(batch.workflows.map((record) => record.id)),
    runs: new Set(batch.runs.map((record) => record.id)),
    jobs: new Set(batch.jobs.map((record) => record.id)),
    sessions: new Set(batch.sessions.map((record) => record.id))
  };
  const entityNames = {
    repositories: 'repository',
    workflows: 'workflow',
    runs: 'run',
    jobs: 'job',
    sessions: 'session'
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
  }
  for (const run of batch.runs) {
    requireReference(run, 'repositoryId', 'repositories');
    requireReference(run, 'workflowId', 'workflows');
  }
  for (const job of batch.jobs) {
    requireReference(job, 'runId', 'runs');
  }
  for (const session of batch.sessions) {
    requireReference(session, 'runId', 'runs');
    if (session.jobId !== undefined && session.jobId !== null) {
      requireReference(session, 'jobId', 'jobs');
    }
  }
  for (const event of batch.events) {
    requireReference(event, 'sessionId', 'sessions');
  }

  return errors;
}