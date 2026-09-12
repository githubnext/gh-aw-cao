import { orderEvents } from '../normalize/index.js';

export const RETENTION_WINDOW_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const BROWSER_RETENTION_WINDOWS_MS = Object.freeze({
  runs: Number.MAX_SAFE_INTEGER
});

/**
 * Stores whose retention is decided by observation time. Structural parents
 * (`packages`, `repositories`, `workflows`) are retained by reachability instead so a
 * retained run never loses its hierarchy.
 * @type {Record<string, string[]>}
 */
const RETENTION_TIMESTAMPS = {
  runs: ['completedAt', 'startedAt', 'observedAt'],
  jobs: ['completedAt', 'startedAt', 'observedAt'],
  sessions: ['completedAt', 'startedAt', 'observedAt'],
  events: ['timestamp', 'observedAt']
};

const STORES = /** @type {const} */ ([
  'packages',
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events'
]);
const RECORD_OVERHEAD_BYTES = 512;

/** @param {Record<string, unknown>} record */
function recordSize(record) {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength + RECORD_OVERHEAD_BYTES;
}

/** @param {import('../model/schema.js').CanonicalBatch} batch */
export function estimateCanonicalBatchBytes(batch) {
  return STORES.reduce((total, storeName) =>
    total + batch[storeName].reduce((storeTotal, record) => storeTotal + recordSize(record), 0), 0);
}

/**
 * Drops whole run subtrees from oldest to newest until the conservative
 * serialized estimate fits. Structural parents remain so future incremental
 * collections can reconnect to them.
 *
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {number} maxBytes
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
export function capCanonicalBatchSize(batch, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new TypeError('Canonical database byte limit must be non-negative');
  let estimatedBytes = estimateCanonicalBatchBytes(batch);
  if (estimatedBytes <= maxBytes) return batch;

  /** @param {Record<string, unknown>[]} records @param {string} field */
  const groupBy = (records, field) => {
    /** @type {Map<string, Record<string, unknown>[]>} */
    const grouped = new Map();
    for (const record of records) {
      const key = String(record[field]);
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return grouped;
  };
  const jobsByRun = groupBy(batch.jobs, 'runId');
  const sessionsByRun = groupBy(batch.sessions, 'runId');
  const eventsBySession = groupBy(batch.events, 'sessionId');
  const evictedRuns = new Set();
  const oldestRuns = [...batch.runs].sort((left, right) =>
    (recordTimestamp('runs', left) ?? Number.NEGATIVE_INFINITY)
      - (recordTimestamp('runs', right) ?? Number.NEGATIVE_INFINITY)
    || String(left.id).localeCompare(String(right.id)));

  for (const run of oldestRuns) {
    if (estimatedBytes <= maxBytes) break;
    const runId = String(run.id);
    evictedRuns.add(runId);
    estimatedBytes -= recordSize(run);
    for (const job of jobsByRun.get(runId) ?? []) estimatedBytes -= recordSize(job);
    for (const session of sessionsByRun.get(runId) ?? []) {
      estimatedBytes -= recordSize(session);
      for (const event of eventsBySession.get(String(session.id)) ?? []) estimatedBytes -= recordSize(event);
    }
  }

  const retainedSessions = batch.sessions.filter((record) => !evictedRuns.has(String(record.runId)));
  const retainedSessionIds = new Set(retainedSessions.map((record) => String(record.id)));
  return {
    packages: batch.packages,
    repositories: batch.repositories,
    workflows: batch.workflows,
    runs: batch.runs.filter((record) => !evictedRuns.has(String(record.id))),
    jobs: batch.jobs.filter((record) => !evictedRuns.has(String(record.runId))),
    sessions: retainedSessions,
    events: batch.events.filter((record) => retainedSessionIds.has(String(record.sessionId)))
  };
}

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
 * @param {number} reference
 * @param {number} defaultRetentionWindowMs
 * @param {Partial<Record<typeof STORES[number], number>>} retentionWindowMsByStore
 */
function upsertRecords(previous, incoming, reference, defaultRetentionWindowMs, retentionWindowMsByStore) {
  /** @type {Record<string, Map<string, Record<string, unknown>>>} */
  const merged = {};
  for (const storeName of STORES) {
    /** @type {Map<string, Record<string, unknown>>} */
    const records = new Map();
    const timeBound = storeName in RETENTION_TIMESTAMPS;
    const configuredWindow = retentionWindowMsByStore[storeName];
    const retentionWindowMs = Number.isFinite(configuredWindow)
      ? Math.max(0, Number(configuredWindow))
      : defaultRetentionWindowMs;
    const horizon = reference - retentionWindowMs;
    for (const record of previous[storeName] ?? []) {
      const timestamp = recordTimestamp(storeName, record);
      if (timeBound && (timestamp === null || timestamp < horizon)) continue;
      records.set(String(record.id), record);
    }
    for (const record of incoming[storeName] ?? []) {
      const timestamp = recordTimestamp(storeName, record);
      if (timeBound && (timestamp === null || timestamp < horizon)) continue;
      records.set(String(record.id), record);
    }
    merged[storeName] = records;
  }
  return merged;
}

/**
 * Drops retained records whose mandatory parents did not survive so the merged
 * batch remains relationship-safe.
 *
 * @param {Record<string, Map<string, Record<string, unknown>>>} merged
 */
function pruneOrphans(merged) {
  const packages = merged.packages;
  const repositories = merged.repositories;
  const workflows = merged.workflows;
  const runs = merged.runs;
  const jobs = merged.jobs;
  const sessions = merged.sessions;

  for (const [id, workflow] of workflows) {
    if (!repositories.has(String(workflow.repositoryId))
      || (workflow.packageId !== undefined
        && workflow.packageId !== null
        && !packages.has(String(workflow.packageId)))) workflows.delete(id);
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
  const incomingPackages = new Set(incoming.packages.map((record) => String(record.id)));
  const incomingWorkflows = new Set(incoming.workflows.map((record) => String(record.id)));
  const incomingRepositories = new Set(incoming.repositories.map((record) => String(record.id)));
  const referencedWorkflows = new Set([...merged.runs.values()].map((run) => String(run.workflowId)));
  for (const [id] of merged.workflows) {
    if (!incomingWorkflows.has(id) && !referencedWorkflows.has(id)) merged.workflows.delete(id);
  }
  const referencedPackages = new Set(
    [...merged.workflows.values()]
      .map((workflow) => workflow.packageId)
      .filter((id) => id !== undefined && id !== null)
      .map(String)
  );
  for (const [id] of merged.packages) {
    if (!incomingPackages.has(id) && !referencedPackages.has(id)) merged.packages.delete(id);
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
 * Upserts one freshly collected batch onto the previously stored records so
 * partial collections never drop retained history, prunes records observed
 * outside the 30-day retention window, and keeps every surviving record
 * relationship-safe.
 *
 * The window ends at the newest incoming observation whenever the collection
 * reports observations later than `now`, so a browser clock behind the
 * producer's clock cannot prune records the current collection still reports.
 *
 * @param {import('../model/schema.js').CanonicalBatch} previous
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{
 *   now?: number,
 *   retentionWindowMs?: number,
 *   retentionWindowMsByStore?: Partial<Record<typeof STORES[number], number>>,
 *   includePreviousInReference?: boolean,
 *   preserveUnreferencedParents?: boolean
 * }} [options]
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
export function mergeRetainedRecords(previous, incoming, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const reference = Math.max(
    now,
    newestObservation(incoming) ?? now,
    options.includePreviousInReference ? (newestObservation(previous) ?? now) : now
  );
  const retentionWindowMs = Number.isFinite(options.retentionWindowMs)
    ? Math.max(0, Number(options.retentionWindowMs))
    : RETENTION_WINDOW_MS;
  const merged = upsertRecords(
    previous,
    incoming,
    reference,
    retentionWindowMs,
    options.retentionWindowMsByStore ?? {}
  );
  pruneOrphans(merged);
  if (!options.preserveUnreferencedParents) collectUnreferencedParents(merged, incoming);

  const batch = /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(
    STORES.map((storeName) => [
      storeName,
      [...merged[storeName].values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
    ])
  ));
  batch.events = orderEvents(batch.events);
  return batch;
}
