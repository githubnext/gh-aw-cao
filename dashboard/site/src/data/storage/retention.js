import { orderEvents } from '../normalize/index.js';

export const RETENTION_WINDOW_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Stores whose retention is decided by observation time. Structural parents
 * (`repositories`, `workflows`) are retained by reachability instead so a
 * retained run never loses its hierarchy.
 * @type {Record<string, string[]>}
 */
const RETENTION_TIMESTAMPS = {
  runs: ['completedAt', 'startedAt', 'observedAt'],
  jobs: ['completedAt', 'startedAt', 'observedAt'],
  sessions: ['completedAt', 'startedAt', 'observedAt'],
  events: ['timestamp', 'observedAt'],
  workItems: ['completedAt', 'startedAt', 'observedAt'],
  findings: ['observedAt']
};

const STORES = /** @type {const} */ ([
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events',
  'workItems',
  'findings'
]);

/**
 * Reports the observation time that bounds a record's retention. Records in a
 * time-bounded store without a usable timestamp are treated as expired so
 * retention can never grow without limit.
 *
 * @param {string} storeName
 * @param {Record<string, unknown>} record
 * @returns {number | null}
 */
export function recordTimestamp(storeName, record) {
  for (const field of RETENTION_TIMESTAMPS[storeName] ?? []) {
    const value = record[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const milliseconds = Date.parse(String(value));
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  return null;
}

/**
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @returns {number | null}
 */
function newestObservation(batch) {
  let newest = null;
  for (const storeName of STORES) {
    for (const record of batch[storeName] ?? []) {
      const timestamp = recordTimestamp(storeName, record);
      if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp;
    }
  }
  return newest;
}

/**
 * @param {import('../model/schema.js').CanonicalBatch} previous
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {string} generation
 * @param {number} horizon
 */
function upsertRecords(previous, incoming, generation, horizon) {
  /** @type {Record<string, Map<string, Record<string, unknown>>>} */
  const merged = {};
  for (const storeName of STORES) {
    /** @type {Map<string, Record<string, unknown>>} */
    const records = new Map();
    const timeBound = storeName in RETENTION_TIMESTAMPS;
    for (const record of previous[storeName] ?? []) {
      const timestamp = recordTimestamp(storeName, record);
      if (timeBound && (timestamp === null || timestamp < horizon)) continue;
      records.set(String(record.id), { ...record, generation });
    }
    for (const record of incoming[storeName] ?? []) {
      records.set(String(record.id), { ...record, generation });
    }
    merged[storeName] = records;
  }
  return merged;
}

/**
 * Drops retained records whose mandatory parents did not survive so the merged
 * generation always passes relationship validation.
 *
 * @param {Record<string, Map<string, Record<string, unknown>>>} merged
 */
function pruneOrphans(merged) {
  const repositories = merged.repositories;
  const workflows = merged.workflows;
  const runs = merged.runs;
  const jobs = merged.jobs;
  const sessions = merged.sessions;

  for (const [id, workflow] of workflows) {
    if (!repositories.has(String(workflow.repositoryId))) workflows.delete(id);
  }
  for (const [id, run] of runs) {
    const workflow = workflows.get(String(run.workflowId));
    if (!repositories.has(String(run.repositoryId))
      || !workflow
      || workflow.repositoryId !== run.repositoryId) runs.delete(id);
  }
  for (const [id, job] of jobs) {
    if (!runs.has(String(job.runId))) jobs.delete(id);
  }
  for (const [id, session] of sessions) {
    if (!runs.has(String(session.runId))) {
      sessions.delete(id);
      continue;
    }
    if (session.jobId === undefined || session.jobId === null) continue;
    const job = jobs.get(String(session.jobId));
    if (!job || job.runId !== session.runId) {
      const withoutJob = { ...session };
      delete withoutJob.jobId;
      sessions.set(id, withoutJob);
    }
  }
  for (const [id, event] of merged.events) {
    if (!sessions.has(String(event.sessionId))) merged.events.delete(id);
  }
}

/**
 * Collects structural parents that neither the current collection nor any
 * retained descendant still references.
 *
 * @param {Record<string, Map<string, Record<string, unknown>>>} merged
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 */
function collectUnreferencedParents(merged, incoming) {
  const incomingWorkflows = new Set(incoming.workflows.map((record) => String(record.id)));
  const incomingRepositories = new Set(incoming.repositories.map((record) => String(record.id)));
  const referencedWorkflows = new Set([...merged.runs.values()].map((run) => String(run.workflowId)));
  for (const [id] of merged.workflows) {
    if (!incomingWorkflows.has(id) && !referencedWorkflows.has(id)) merged.workflows.delete(id);
  }
  const referencedRepositories = new Set([
    ...[...merged.workflows.values()].map((workflow) => String(workflow.repositoryId)),
    ...[...merged.runs.values()].map((run) => String(run.repositoryId))
  ]);
  for (const [id] of merged.repositories) {
    if (!incomingRepositories.has(id) && !referencedRepositories.has(id)) merged.repositories.delete(id);
  }
}

/**
 * Upserts one freshly collected batch onto the previously stored generation so
 * partial collections never drop retained history, prunes records observed
 * outside the 30-day retention window, and keeps every surviving record
 * relationship-safe.
 *
 * @param {import('../model/schema.js').CanonicalBatch} previous
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{ generation: string, now?: number }} options
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
export function mergeRetainedGeneration(previous, incoming, options) {
  const generation = options.generation;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const reference = Math.max(now, newestObservation(incoming) ?? now);
  const merged = upsertRecords(previous, incoming, generation, reference - RETENTION_WINDOW_MS);
  pruneOrphans(merged);
  collectUnreferencedParents(merged, incoming);

  const batch = /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(
    STORES.map((storeName) => [
      storeName,
      [...merged[storeName].values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
    ])
  ));
  batch.events = orderEvents(batch.events);
  return batch;
}
