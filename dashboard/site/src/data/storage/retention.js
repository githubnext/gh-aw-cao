import { orderRunRecords } from '../normalize/index.js';

export const RETENTION_WINDOW_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const BROWSER_RETENTION_WINDOWS_MS = Object.freeze({
  runs: Number.MAX_SAFE_INTEGER
});

/**
 * Stores whose retention is decided by observation time. Structural parents
 * are never TTLed: repositories and workflows are retained by reachability so
 * a retained run never loses its hierarchy, while campaigns persist across imports.
 * @type {Record<string, string[]>}
 */
const RETENTION_TIMESTAMPS = {
  runs: ['completedAt', 'startedAt', 'observedAt'],
  domains: ['timestamp', 'observedAt'],
  tools: ['timestamp', 'observedAt'],
  audits: ['timestamp', 'observedAt'],
  issues: ['timestamp', 'observedAt']
};

const STORES = /** @type {const} */ ([
  'campaigns',
  'repositories',
  'workflows',
  'runs',
  'domains',
  'tools',
  'audits',
  'issues'
]);
const RUN_LINKED_STORES = /** @type {const} */ (['domains', 'tools', 'audits', 'issues']);
const WORKFLOW_INVENTORY_FIELDS = /** @type {const} */ ([
  'campaignId',
  'campaign',
  'campaignName',
  'campaignIcon',
  'githubId',
  'registryState',
  'createdAt',
  'updatedAt'
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
  const recordsByRun = Object.fromEntries(RUN_LINKED_STORES.map((storeName) => [
    storeName,
    groupBy(batch[storeName], 'runId')
  ]));
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
    for (const storeName of RUN_LINKED_STORES) {
      for (const record of recordsByRun[storeName].get(runId) ?? []) estimatedBytes -= recordSize(record);
    }
  }

  return /** @type {import('../model/schema.js').CanonicalBatch} */ ({
    campaigns: batch.campaigns,
    repositories: batch.repositories,
    workflows: batch.workflows,
    runs: batch.runs.filter((record) => !evictedRuns.has(String(record.id))),
    ...Object.fromEntries(RUN_LINKED_STORES.map((storeName) => [
      storeName,
      batch[storeName].filter((record) => !evictedRuns.has(String(record.runId)))
    ]))
  });
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
 * @param {boolean} preserveWorkflowCampaignMappings
 * @param {boolean} preserveRepositoryRecords
 */
function upsertRecords(
  previous,
  incoming,
  reference,
  defaultRetentionWindowMs,
  retentionWindowMsByStore,
  preserveWorkflowCampaignMappings,
  preserveRepositoryRecords
) {
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
      const id = String(record.id);
      // Discovery owns repository metadata, so run-derived observations may only
      // backfill missing repository records and must never overwrite existing ones.
      if (storeName === 'repositories' && preserveRepositoryRecords && records.has(id)) continue;
      // Inventory discovery owns campaign membership and registry metadata.
      // Run-derived observations may enrich other workflow fields only.
      if (storeName === 'workflows' && preserveWorkflowCampaignMappings) {
        const existing = records.get(id);
        if (existing) {
          const inventoryFields = existing.registryState === undefined
            ? WORKFLOW_INVENTORY_FIELDS
            : [...WORKFLOW_INVENTORY_FIELDS, 'state', 'name', 'path', 'workflowLink'];
          const preserved = Object.fromEntries(inventoryFields
            .filter((field) => existing[field] !== undefined)
            .map((field) => [field, existing[field]]));
          records.set(id, { ...record, ...preserved });
          continue;
        }
      }
      records.set(id, record);
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
  const campaigns = merged.campaigns;
  const repositories = merged.repositories;
  const workflows = merged.workflows;
  const runs = merged.runs;

  for (const [id, workflow] of workflows) {
    if (!repositories.has(String(workflow.repositoryId))
      || (workflow.campaignId !== undefined
        && workflow.campaignId !== null
        && !campaigns.has(String(workflow.campaignId)))) workflows.delete(id);
  }
  for (const [id, run] of runs) {
    const workflow = workflows.get(String(run.workflowId));
    if (!repositories.has(String(run.repositoryId))
      || !workflow
      || workflow.repositoryId !== run.repositoryId) runs.delete(id);
  }
  for (const storeName of RUN_LINKED_STORES) {
    for (const [id, record] of merged[storeName]) {
      if (!runs.has(String(record.runId))) merged[storeName].delete(id);
    }
  }
}

/**
 * Collects repository and workflow parents that neither the current collection
 * nor any retained descendant still references. Campaign records are durable
 * inventory and are never collected during imports.
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
 *   preserveUnreferencedParents?: boolean,
 *   preserveWorkflowCampaignMappings?: boolean,
 *   preserveRepositoryRecords?: boolean
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
    options.retentionWindowMsByStore ?? {},
    options.preserveWorkflowCampaignMappings === true,
    options.preserveRepositoryRecords === true
  );
  pruneOrphans(merged);
  if (!options.preserveUnreferencedParents) collectUnreferencedParents(merged, incoming);

  const batch = /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(
    STORES.map((storeName) => [
      storeName,
      [...merged[storeName].values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
    ])
  ));
  for (const storeName of RUN_LINKED_STORES) {
    batch[storeName] = orderRunRecords(batch[storeName]);
  }
  return batch;
}
