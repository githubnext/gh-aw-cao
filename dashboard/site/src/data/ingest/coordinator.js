import { queryDashboardSourceObservations } from '../queries/ingestion.js';
import {
  adaptCachedGhAwJsonl,
  adaptCachedGhAwJsonlStream,
  adaptGhAwLogs,
  cachedJsonlPayloadIdentity
} from '../adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../adapters/sql-export.js';
import { buildDailyOverviewAggregates } from '../analytics/daily-overview-aggregates.js';
import { CANONICAL_SCHEMA_VERSION } from '../model/schema.js';
import { normalize } from '../normalize/index.js';
import {
  publishDailyOverviewAggregates,
  pruneStaleDailyOverviewAggregates,
  readCanonicalBatch,
  readTransaction,
  recordTransaction,
  replaceCanonicalBatch,
  withCanonicalIngestionLock
} from '../storage/indexeddb.js';
import { capCanonicalBatchSize, estimateCanonicalBatchBytes, mergeRetainedRecords } from '../storage/retention.js';
import {
  inspectDatabaseUsage,
  inspectStorage,
  MAX_DASHBOARD_DATABASE_BYTES,
  requestPersistentStorage
} from '../storage/quota.js';
import { CanonicalIngestionError, classifyIngestionError } from './errors.js';
import { createDebug } from '../../debug.js';

const debug = createDebug('data:ingestion');

const DASHBOARD_SOURCE_INGESTION_VERSION = 5;
const GH_AW_JSONL_INGESTION_VERSION = 4;
export const NORMALIZED_JSON_INGESTION_VERSION = 2;
const MAX_QUOTA_RECOVERY_ATTEMPTS = 4;
const MAX_USAGE_RECOVERY_ATTEMPTS = 4;
const NORMALIZED_BATCH_COLLECTIONS = /** @type {const} */ ([
  'campaigns',
  'repositories',
  'workflows',
  'runs',
  'domains',
  'tools',
  'audits',
  'issues'
]);
const LEGACY_PACKAGE_FIELD_ALIASES = /** @type {const} */ ({
  packageId: 'campaignId',
  package: 'campaign',
  packageName: 'campaignName',
  packageIcon: 'campaignIcon',
  packageLink: 'campaignLink'
});
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();
let dailyOverviewAggregateGenerationSequence = 0;

/**
 * Generates a unique, monotonically-informative generation id for a daily
 * overview aggregate rebuild (spec §72.5). Uniqueness (not format) is the
 * only requirement: publication safety comes from writing the new
 * generation's records under this id before atomically republishing
 * metadata, not from any property of the id itself.
 */
function nextDailyOverviewAggregateGeneration() {
  dailyOverviewAggregateGenerationSequence += 1;
  return `${Date.now().toString(36)}-${dailyOverviewAggregateGenerationSequence.toString(36)}`;
}

/**
 * Builds and publishes a fresh daily overview aggregate generation from the
 * canonical batch that was just committed, then garbage-collects any
 * superseded generation. This derives the projection from the normalized
 * batch already in memory (spec §72.5) rather than re-reading IndexedDB.
 *
 * Best effort: aggregate publication is a derived, reconstructable
 * projection (INV-004), so a failure here MUST NOT fail canonical
 * ingestion. Readers fail closed (see `readDailyOverviewAggregates`) and
 * fall back to the canonical query path whenever the projection is stale,
 * absent, or incompatible.
 *
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 */
async function publishDailyOverviewAggregatesForBatch(indexedDB, batch) {
  try {
    const dailyAggregates = buildDailyOverviewAggregates(batch.runs);
    await publishDailyOverviewAggregates(indexedDB, {
      generation: nextDailyOverviewAggregateGeneration(),
      dailyAggregates
    });
    await pruneStaleDailyOverviewAggregates(indexedDB);
  } catch (error) {
    debug('failed to publish daily overview aggregates; canonical query path remains authoritative', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Recognizes storage exhaustion across browsers that report it as a
 * `DOMException` and browsers that report it as a standalone error class.
 * @param {unknown} error
 */
function isQuotaExceededError(error) {
  return typeof error === 'object'
    && error !== null
    && /** @type {{ name?: unknown }} */ (error).name === 'QuotaExceededError';
}

/** @param {unknown} value */
function migrateLegacyPackageId(value) {
  return typeof value === 'string' && value.startsWith('package:')
    ? `campaign:${value.slice('package:'.length)}`
    : value;
}

/** @param {unknown} value */
function hasLegacyPackageAliases(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (
    (typeof /** @type {{ id?: unknown }} */ (value).id === 'string'
      && /** @type {{ id: string }} */ (value).id.startsWith('package:'))
    || (typeof /** @type {{ campaignId?: unknown }} */ (value).campaignId === 'string'
      && /** @type {{ campaignId: string }} */ (value).campaignId.startsWith('package:'))
    || Object.keys(LEGACY_PACKAGE_FIELD_ALIASES).some((field) => Object.hasOwn(value, field))
  ));
}

/** @param {unknown} candidate */
function migrateLegacyPackageAliases(candidate) {
  if (!hasLegacyPackageAliases(candidate)) return candidate;
  const record = { .../** @type {Record<string, unknown>} */ (candidate) };
  record.id = migrateLegacyPackageId(record.id);
  record.campaignId = migrateLegacyPackageId(record.campaignId);
  for (const [legacyField, campaignField] of Object.entries(LEGACY_PACKAGE_FIELD_ALIASES)) {
    if (record[campaignField] === undefined && record[legacyField] !== undefined) {
      record[campaignField] = legacyField === 'packageId'
        ? migrateLegacyPackageId(record[legacyField])
        : record[legacyField];
    }
    delete record[legacyField];
  }
  return record;
}

/**
 * Accepts normalized shards emitted shortly before the package-to-campaign
 * vocabulary rename. The schema and ingestion versions did not change in that
 * transition, so cached payloads may still contain the legacy collection and
 * relationship field names.
 *
 * @param {Record<string, unknown>} batch
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
function migrateNormalizedBatch(batch) {
  if (!Array.isArray(batch.packages)) {
    return /** @type {import('../model/schema.js').CanonicalBatch} */ (batch);
  }
  const migrated = { ...batch };
  if (!Array.isArray(migrated.campaigns) && Array.isArray(migrated.packages)) {
    migrated.campaigns = migrated.packages.map(migrateLegacyPackageAliases);
  }
  for (const collection of NORMALIZED_BATCH_COLLECTIONS) {
    if (Array.isArray(migrated[collection])) {
      migrated[collection] = migrated[collection].map(migrateLegacyPackageAliases);
    }
  }
  delete migrated.packages;
  return /** @type {import('../model/schema.js').CanonicalBatch} */ (migrated);
}

/**
 * @param {unknown} payload
 * @param {string | undefined} identity
 */
async function payloadHash(payload, identity) {
  const value = identity ?? (
    typeof payload === 'string' || ArrayBuffer.isView(payload)
      ? payload
      : JSON.stringify(payload)
  );
  const bytes = typeof value === 'string' ? undefined : /** @type {Uint8Array} */ (value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : /** @type {BufferSource} */ (bytes)
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const hashes = Array.from({ length: 8 }, (_, index) => (0x811c9dc5 ^ (index * 0x9e3779b9)) >>> 0);
  const length = typeof value === 'string' ? value.length : /** @type {Uint8Array} */ (bytes).length;
  for (let offset = 0; offset < length; offset += 1) {
    const code = typeof value === 'string'
      ? value.charCodeAt(offset)
      : /** @type {Uint8Array} */ (bytes)[offset];
    for (let index = 0; index < hashes.length; index += 1) {
      hashes[index] = Math.imul(hashes[index] ^ code, 0x01000193 + (index * 2)) >>> 0;
    }
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, '0')).join('');
}

/** @param {string} kind @param {string} scope */
async function transactionId(kind, scope) {
  return `${kind}:current:${await payloadHash(scope, undefined)}`;
}

/** @param {string} hash */
function normalizedShardTransactionId(hash) {
  return `ingest-normalized-json:sha256:${hash}:v${NORMALIZED_JSON_INGESTION_VERSION}`;
}

/** @param {{ context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} options */
export function cachedJsonlAdaptationContext(options) {
  return JSON.stringify({
    ingestionVersion: GH_AW_JSONL_INGESTION_VERSION,
    context: options.context ?? null,
    workflowHints: options.workflowHints ?? []
  });
}

/** @param {IDBFactory} indexedDB @param {string} kind @param {string} scope */
export async function readCurrentIngestion(indexedDB, kind, scope) {
  return await readTransaction(indexedDB, await transactionId(kind, scope));
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ payloadIdentity: string, payloadScope: string, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} options
 */
export async function isCachedGhAwJsonlCurrent(indexedDB, options) {
  const adaptationContext = cachedJsonlAdaptationContext(options);
  const current = await readCurrentIngestion(indexedDB, 'ingest-jsonl', options.payloadScope);
  return current?.payloadHash === options.payloadIdentity
    && current.adaptationContext === adaptationContext
    && current.ingestionVersion === GH_AW_JSONL_INGESTION_VERSION;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ payloadIdentity: string, payloadScope: string }} options
 */
export async function isNormalizedJsonCurrent(indexedDB, options) {
  const receiptId = normalizedShardTransactionId(options.payloadIdentity);
  const receipt = await readTransaction(indexedDB, receiptId);
  if (receipt?.payloadHash === options.payloadIdentity
      && receipt.ingestionVersion === NORMALIZED_JSON_INGESTION_VERSION) {
    return true;
  }
  const legacyReceipt = await readCurrentIngestion(indexedDB, 'ingest-normalized-json', options.payloadScope);
  if (legacyReceipt?.payloadHash !== options.payloadIdentity
      || legacyReceipt.ingestionVersion !== NORMALIZED_JSON_INGESTION_VERSION) {
    return false;
  }
  await recordTransaction(indexedDB, { ...legacyReceipt, id: receiptId });
  return true;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string} kind
 * @param {string} scope
 * @param {string} hash
 * @param {number} ingestionVersion
 */
async function previouslyIngested(indexedDB, kind, scope, hash, ingestionVersion) {
  const transaction = await readCurrentIngestion(indexedDB, kind, scope);
  return transaction?.payloadHash === hash
    && transaction.ingestionVersion === ingestionVersion;
}

let ingestionQueue = Promise.resolve();

/**
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {() => Promise<T>} task
 * @param {{ onLockWait?: () => void, signal?: AbortSignal }} [options]
 */
function serializeIngestion(indexedDB, task, options = {}) {
  const lockedTask = () => {
    options.signal?.throwIfAborted();
    return withCanonicalIngestionLock(indexedDB, task, { onWaiting: options.onLockWait });
  };
  const result = ingestionQueue.then(lockedTask, lockedTask);
  ingestionQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, preserveWorkflowCampaignMappings?: boolean, preserveRepositoryRecords?: boolean, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, signal?: AbortSignal }} options
 */
async function ingestCanonicalBatch(indexedDB, incoming, options) {
  options.signal?.throwIfAborted();
  if (options.storage) {
    await Promise.allSettled([
      inspectStorage(options.storage),
      requestPersistentStorage(options.storage)
    ]);
  }
  const retained = await readCanonicalBatch(indexedDB);
  options.signal?.throwIfAborted();
  const maxDatabaseBytes = Number.isFinite(options.maxDatabaseBytes)
    ? Math.max(0, Number(options.maxDatabaseBytes))
    : MAX_DASHBOARD_DATABASE_BYTES;
  // Leave conservative room for structured-clone and index overhead on
  // browsers that do not report per-IndexedDB usage.
  const targetDatabaseBytes = Math.floor(maxDatabaseBytes * 0.75);
  let batch = capCanonicalBatchSize(mergeRetainedRecords(retained, incoming, {
    now: options.now,
    retentionWindowMs: options.retentionWindowMs,
    retentionWindowMsByStore: options.retentionWindowMsByStore,
    preserveWorkflowCampaignMappings: options.preserveWorkflowCampaignMappings,
    preserveRepositoryRecords: options.preserveRepositoryRecords
  }), targetDatabaseBytes);
  let writeMetrics = {
    durationMs: 0,
    requestCount: 0,
    storedRecords: 0,
    deletedRecords: 0,
    scannedKeys: 0,
    committedBatches: 0,
    abortedTransactions: 0
  };
  let previousBatch = retained;
  const write = async () => {
    await replaceCanonicalBatch(indexedDB, batch, {
      onProgress: options.onWriteProgress,
      onMetrics: (metrics) => { writeMetrics = metrics; },
      previousBatch,
      signal: options.signal
    });
    previousBatch = batch;
  };
  // Every write of a large batch costs minutes in a constrained browser, so
  // recovery halves the batch a bounded number of times and then reports the
  // quota failure instead of retrying until the tab looks stuck.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await write();
      options.signal?.throwIfAborted();
      break;
    } catch (error) {
      if (!isQuotaExceededError(error) || attempt >= MAX_QUOTA_RECOVERY_ATTEMPTS) throw error;
      previousBatch = await readCanonicalBatch(indexedDB);
      options.signal?.throwIfAborted();
      const reduced = capCanonicalBatchSize(batch, Math.floor(estimateCanonicalBatchBytes(batch) * 0.5));
      if (reduced.runs.length === batch.runs.length) throw error;
      debug('retrying canonical write after quota pressure', {
        attempt: attempt + 1,
        retainedRecords: Object.values(previousBatch).reduce((total, records) => total + records.length, 0),
        previousRuns: batch.runs.length,
        targetRuns: reduced.runs.length
      });
      batch = reduced;
    }
  }
  if (options.storage) {
    // Shrinking is best effort: when the cap is exhausted the stored batch is
    // accepted as is rather than rewritten indefinitely.
    for (let attempt = 0; attempt < MAX_USAGE_RECOVERY_ATTEMPTS; attempt += 1) {
      const databaseUsage = await inspectDatabaseUsage(options.storage).catch(() => null);
      if (databaseUsage === null || databaseUsage <= maxDatabaseBytes || batch.runs.length === 0) break;
      const target = Math.floor(estimateCanonicalBatchBytes(batch) * (maxDatabaseBytes / databaseUsage) * 0.9);
      const reduced = capCanonicalBatchSize(batch, target);
      if (reduced.runs.length === batch.runs.length) break;
      debug('shrinking canonical batch after storage usage check', {
        attempt: attempt + 1,
        databaseUsage,
        maxDatabaseBytes,
        previousRuns: batch.runs.length,
        targetRuns: reduced.runs.length
      });
      batch = reduced;
      await write();
    }
  }
  await publishDailyOverviewAggregatesForBatch(indexedDB, batch);
  return {
    updated: true,
    committedBatches: 0,
    committedRecords: Object.values(batch).reduce((total, records) => total + records.length, 0),
    idb: writeMetrics
  };
}

/**
 * Upserts the current published source document onto retained canonical records.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, payloadIdentity?: string, payloadScope?: string, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, onLockWait?: () => void, signal?: AbortSignal }} [options]
 */
export function ingestDashboardSources(indexedDB, sources, options = {}) {
  return serializeIngestion(
    indexedDB,
    () => ingestDashboardSourcesNow(indexedDB, sources, options),
    { onLockWait: options.onLockWait, signal: options.signal }
  );
}

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, payloadIdentity?: string, payloadScope?: string, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, signal?: AbortSignal }} options
 */
async function ingestDashboardSourcesNow(indexedDB, sources, options) {
  let phase = 'adapting';
  try {
    const hash = await payloadHash(sources, options.payloadIdentity);
    options.signal?.throwIfAborted();
    const scope = options.payloadScope ?? 'dashboard-sources';
    if (await previouslyIngested(
      indexedDB,
      'ingest-dashboard-sources',
      scope,
      hash,
      DASHBOARD_SOURCE_INGESTION_VERSION
    )) {
      debug('skipped unchanged dashboard source shard', { scope });
      return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
    }
    const adapted = queryDashboardSourceObservations(sources);
    phase = 'normalizing';
    const batch = normalize(adapted.observations);
    phase = 'writing';
    const result = await ingestCanonicalBatch(indexedDB, batch, options);
    options.signal?.throwIfAborted();
    await recordTransaction(indexedDB, {
      id: await transactionId('ingest-dashboard-sources', scope),
      kind: 'ingest-dashboard-sources',
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      payloadScope: scope,
      payloadHash: hash,
      ingestionVersion: DASHBOARD_SOURCE_INGESTION_VERSION,
      committedRecords: result.committedRecords,
      storage: result.idb
    });
    return result;
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}

/**
 * Upserts one complete SQL export onto retained canonical records.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number }} [options]
 */
export async function ingestSqlExport(indexedDB, input, options = {}) {
  let phase = 'adapting';
  try {
    const adapted = adaptSqlExport(input);
    phase = 'normalizing';
    const batch = normalize(adapted.observations);
    phase = 'writing';
    return await ingestCanonicalBatch(indexedDB, batch, options);
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}

/**
 * Upserts one complete gh-aw artifact input onto retained canonical records.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number }} [options]
 */
export async function ingestGhAwLogs(indexedDB, input, options = {}) {
  let phase = 'adapting';
  try {
    const adapted = adaptGhAwLogs(input);
    phase = 'normalizing';
    const batch = normalize(adapted.observations);
    phase = 'writing';
    return await ingestCanonicalBatch(indexedDB, batch, {
      ...options,
      preserveWorkflowCampaignMappings: true,
      preserveRepositoryRecords: true
    });
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}

/**
 * Imports a build-time normalized activity shard without browser-side
 * adaptation or normalization.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, onLockWait?: () => void, payloadIdentity: string, payloadScope: string, expectedPhase?: 'runs' | 'records', signal?: AbortSignal }} options
 */
export function ingestNormalizedJson(indexedDB, input, options) {
  return serializeIngestion(indexedDB, async () => {
    let phase = 'adapting';
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Normalized activity payload must be an object');
      }
      const payload = /** @type {{ schemaVersion?: unknown, ingestionVersion?: unknown, sourceRecords?: unknown, phase?: unknown, batch?: unknown }} */ (input);
      if (payload.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
        throw new TypeError(`Unsupported normalized activity schema: ${String(payload.schemaVersion)}`);
      }
      if (payload.ingestionVersion !== NORMALIZED_JSON_INGESTION_VERSION) {
        throw new TypeError(`Unsupported normalized activity ingestion version: ${String(payload.ingestionVersion)}`);
      }
      if (!payload.batch || typeof payload.batch !== 'object' || Array.isArray(payload.batch)) {
        throw new TypeError('Normalized activity payload must include a canonical batch');
      }
      const batch = migrateNormalizedBatch(/** @type {Record<string, unknown>} */ (payload.batch));
      for (const collection of NORMALIZED_BATCH_COLLECTIONS) {
        if (!Array.isArray(batch[collection])) {
          throw new TypeError(`Normalized activity payload is missing ${collection}`);
        }
      }
      if (options.expectedPhase) {
        if (payload.phase !== options.expectedPhase) {
          throw new TypeError(`Normalized activity payload phase must be ${options.expectedPhase}`);
        }
        const excluded = options.expectedPhase === 'runs'
          ? ['domains', 'tools', 'audits', 'issues']
          : ['campaigns', 'repositories', 'workflows', 'runs'];
        for (const collection of excluded) {
          if (batch[/** @type {keyof import('../model/schema.js').CanonicalBatch} */ (collection)].length > 0) {
            throw new TypeError(`Normalized ${options.expectedPhase} payload must not include ${collection}`);
          }
        }
      }
      if (await isNormalizedJsonCurrent(indexedDB, options)) {
        debug('skipped unchanged normalized activity shard', { scope: options.payloadScope });
        return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
      }
      phase = 'writing';
      const storageStartedAt = monotonicNow();
      const result = await ingestCanonicalBatch(indexedDB, batch, {
        ...options,
        preserveWorkflowCampaignMappings: true,
        preserveRepositoryRecords: true
      });
      options.signal?.throwIfAborted();
      const timings = { parsingMs: 0, normalizationMs: 0, storageMs: monotonicNow() - storageStartedAt };
      await recordTransaction(indexedDB, {
        id: normalizedShardTransactionId(options.payloadIdentity),
        kind: 'ingest-normalized-json',
        createdAt: new Date(options.now ?? Date.now()).toISOString(),
        payloadScope: options.payloadScope,
        payloadHash: options.payloadIdentity,
        ingestionVersion: NORMALIZED_JSON_INGESTION_VERSION,
        records: Number(payload.sourceRecords ?? 0),
        committedRecords: result.committedRecords,
        storage: result.idb,
        timings
      });
      return { ...result, records: Number(payload.sourceRecords ?? 0), timings };
    } catch (error) {
      if (error instanceof CanonicalIngestionError) throw error;
      throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
    }
  }, { onLockWait: options.onLockWait, signal: options.signal });
}

/**
 * Incrementally upserts schema-v2 gh-aw cached JSONL into canonical storage.
 * @param {IDBFactory} indexedDB
 * @param {string | Uint8Array | AsyncIterable<string | Uint8Array>} content
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], onProgress?: (progress: { bytesProcessed: number, linesProcessed: number, recordsIngested: number }) => void, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, payloadIdentity?: string, payloadEtag?: string, payloadScope?: string, onLockWait?: () => void, signal?: AbortSignal }} [options]
 */
export function ingestCachedGhAwJsonl(indexedDB, content, options = {}) {
  return serializeIngestion(
    indexedDB,
    () => ingestCachedGhAwJsonlNow(indexedDB, content, options),
    { onLockWait: options.onLockWait, signal: options.signal }
  );
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string | Uint8Array | AsyncIterable<string | Uint8Array>} content
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], onProgress?: (progress: { bytesProcessed: number, linesProcessed: number, recordsIngested: number }) => void, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, payloadIdentity?: string, payloadEtag?: string, payloadScope?: string, signal?: AbortSignal }} options
 */
async function ingestCachedGhAwJsonlNow(indexedDB, content, options) {
  const createdAt = new Date(options.now ?? Date.now()).toISOString();
  const startedAt = monotonicNow();
  let phase = 'adapting';
  debug('starting JSONL stream ingestion', {
    streaming: typeof content !== 'string' && !ArrayBuffer.isView(content),
    hasPublishedIdentity: typeof options.payloadIdentity === 'string',
    workflowHints: options.workflowHints?.length ?? 0
  });
  try {
    options.signal?.throwIfAborted();
    const adaptationContext = cachedJsonlAdaptationContext(options);
    const scope = options.payloadScope ?? 'gh-aw-jsonl';
    const publishedIdentity = options.payloadIdentity;
    if (publishedIdentity) {
      const current = await readCurrentIngestion(indexedDB, 'ingest-jsonl', scope);
      if (current?.payloadHash === publishedIdentity
          && current.adaptationContext === adaptationContext
          && current.ingestionVersion === GH_AW_JSONL_INGESTION_VERSION) {
        if (options.payloadEtag && current.payloadEtag !== options.payloadEtag) {
          await recordTransaction(indexedDB, { ...current, payloadEtag: options.payloadEtag });
        }
        debug('skipped unchanged JSONL shard', { scope });
        return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
      }
    }
    const streamed = typeof content !== 'string'
      && !ArrayBuffer.isView(content)
      && Symbol.asyncIterator in Object(content)
      ? await adaptCachedGhAwJsonlStream(
          /** @type {AsyncIterable<string | Uint8Array>} */ (content),
          {
           context: options.context,
           workflowHints: options.workflowHints,
           onProgress: options.onProgress,
           payloadIdentity: options.payloadIdentity
          }
        )
      : undefined;
    const payloadIdentity = options.payloadIdentity
      ?? streamed?.payloadIdentity
      ?? cachedJsonlPayloadIdentity(/** @type {string | Uint8Array} */ (content));
    const parsingMs = monotonicNow() - startedAt;
    const current = publishedIdentity
      ? null
      : await readCurrentIngestion(indexedDB, 'ingest-jsonl', scope);
    if (current?.payloadHash === payloadIdentity
        && current.adaptationContext === adaptationContext
        && current.ingestionVersion === GH_AW_JSONL_INGESTION_VERSION) {
      if (options.payloadEtag
          && (current.payloadEtag !== options.payloadEtag || current.adaptationContext !== adaptationContext)) {
        await recordTransaction(indexedDB, {
          ...current,
          payloadEtag: options.payloadEtag,
          adaptationContext
        });
      }
      debug('skipped current JSONL stream', {
        records: current.records ?? null,
        parsingMs
      });
      return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
    }
    const adapted = streamed ?? adaptCachedGhAwJsonl(
      /** @type {string | Uint8Array} */ (content),
      { context: options.context, workflowHints: options.workflowHints }
    );
    phase = 'normalizing';
    const normalizationStartedAt = monotonicNow();
    const batch = normalize(adapted.observations);
    options.signal?.throwIfAborted();
    const normalizationMs = monotonicNow() - normalizationStartedAt;
    debug('normalized JSONL stream', {
      sourceRecords: adapted.records,
      runs: batch.runs.length,
      domains: batch.domains.length,
      tools: batch.tools.length,
      audits: batch.audits.length,
      issues: batch.issues.length
    });
    phase = 'writing';
    const storageStartedAt = monotonicNow();
    const result = await ingestCanonicalBatch(indexedDB, batch, {
      ...options,
      preserveWorkflowCampaignMappings: true,
      preserveRepositoryRecords: true
    });
    options.signal?.throwIfAborted();
    const storageMs = monotonicNow() - storageStartedAt;
    const timings = { parsingMs, normalizationMs, storageMs };
    await recordTransaction(indexedDB, {
      id: await transactionId('ingest-jsonl', scope),
      kind: 'ingest-jsonl',
      createdAt,
      payloadScope: scope,
      payloadHash: payloadIdentity,
      payloadEtag: options.payloadEtag,
      adaptationContext,
      ingestionVersion: GH_AW_JSONL_INGESTION_VERSION,
      records: adapted.records,
      committedRecords: result.committedRecords,
      storage: result.idb,
      rawPayloadRecords: adapted.rawPayloadRecords,
      rawRuns: adapted.rawRuns,
      agenticRunRecords: adapted.agenticRunRecords,
      agenticRuns: adapted.agenticRuns,
      duplicateRawRunObservations: adapted.duplicateRawRunObservations,
      duplicateAgenticRunObservations: adapted.duplicateAgenticRunObservations,
      unenrichedRuns: adapted.unenrichedRuns,
      timings
    });
    debug('recorded successful JSONL transaction', {
      sourceRecords: adapted.records,
      committedRecords: result.committedRecords,
      ...timings
    });
    return {
      ...result,
      records: adapted.records,
      rawPayloadRecords: adapted.rawPayloadRecords,
      rawRuns: adapted.rawRuns,
      agenticRunRecords: adapted.agenticRunRecords,
      agenticRuns: adapted.agenticRuns,
      duplicateRawRunObservations: adapted.duplicateRawRunObservations,
      duplicateAgenticRunObservations: adapted.duplicateAgenticRunObservations,
      unenrichedRuns: adapted.unenrichedRuns,
      recordsByKind: adapted.recordsByKind,
      rateLimits: adapted.rateLimits,
      mappedRateLimits: adapted.mappedRateLimits,
      timings
    };
  } catch (error) {
    debug('JSONL stream ingestion failed', {
      phase,
      error: error instanceof Error ? error.name : 'Error'
    });
    await recordTransaction(indexedDB, {
      id: `ingest-jsonl-failed:${createdAt}`,
      kind: 'ingest-jsonl-failed',
      createdAt,
      error: error instanceof Error ? error.name : 'Error'
    }).catch(() => undefined);
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}
