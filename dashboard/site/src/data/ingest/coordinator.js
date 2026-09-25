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
  ENTITY_STORES,
  maintainCanonicalDatabase,
  readCollection,
  readRecord,
  readTransaction,
  recordTransaction,
  upsertCanonicalBatch,
  withCanonicalIngestionLock
} from '../storage/indexeddb.js';
import {
  capCanonicalBatchSize,
  estimateCanonicalBatchBytes,
  mergeActivityStructuralRecord
} from '../storage/retention.js';
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
export const NORMALIZED_JSONL_INGESTION_VERSION = 3;
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
  'issues',
  'operationalValues'
]);
const NORMALIZED_JSONL_WRITE_BATCH_SIZE = 250;
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
function normalizedJsonlShardTransactionId(hash) {
  return `ingest-normalized-jsonl:sha256:${hash}:v${NORMALIZED_JSONL_INGESTION_VERSION}`;
}

/** @param {string} hash */
function cachedJsonlShardTransactionId(hash) {
  return `ingest-jsonl:sha256:${hash}:v${GH_AW_JSONL_INGESTION_VERSION}`;
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
 * @param {string} payloadIdentity
 */
async function readCachedJsonlShardReceipt(indexedDB, payloadIdentity) {
  return await readTransaction(indexedDB, cachedJsonlShardTransactionId(payloadIdentity));
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ payloadIdentity: string, payloadScope: string, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} options
 */
export async function isCachedGhAwJsonlCurrent(indexedDB, options) {
  const adaptationContext = cachedJsonlAdaptationContext(options);
  const receipt = await readCachedJsonlShardReceipt(indexedDB, options.payloadIdentity);
  return receipt?.payloadHash === options.payloadIdentity
    && receipt.adaptationContext === adaptationContext
    && receipt.ingestionVersion === GH_AW_JSONL_INGESTION_VERSION;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ payloadIdentity: string, expectedPhase?: 'runs' | 'records' }} options
 */
export async function isNormalizedJsonlCurrent(indexedDB, options) {
  const receipt = await readTransaction(indexedDB, normalizedJsonlShardTransactionId(options.payloadIdentity));
  return receipt?.kind === 'ingest-normalized-jsonl'
    && receipt.payloadHash === options.payloadIdentity
    && receipt.ingestionVersion === NORMALIZED_JSONL_INGESTION_VERSION
    && (options.expectedPhase !== 'runs' || Number.isSafeInteger(receipt.rawRuns));
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
  let databaseUsage = null;
  if (options.storage) {
    await Promise.allSettled([
      inspectStorage(options.storage),
      requestPersistentStorage(options.storage)
    ]);
  }
  const maxDatabaseBytes = Number.isFinite(options.maxDatabaseBytes)
    ? Math.max(0, Number(options.maxDatabaseBytes))
    : MAX_DASHBOARD_DATABASE_BYTES;
  let batch = incoming;
  if (options.preserveRepositoryRecords || options.preserveWorkflowCampaignMappings) {
    batch = {
      ...incoming,
      repositories: options.preserveRepositoryRecords
        ? await Promise.all(incoming.repositories.map(async (record) =>
            mergeActivityStructuralRecord(
              'repositories',
              /** @type {Record<string, unknown> | undefined} */ (
                await readRecord(indexedDB, 'repositories', String(record.id)) ?? undefined
              ),
              record
            )))
        : incoming.repositories,
      workflows: options.preserveWorkflowCampaignMappings
        ? await Promise.all(incoming.workflows.map(async (record) =>
            mergeActivityStructuralRecord(
              'workflows',
              /** @type {Record<string, unknown> | undefined} */ (
                await readRecord(indexedDB, 'workflows', String(record.id)) ?? undefined
              ),
              record
            )))
        : incoming.workflows
    };
  }
  let writeMetrics = {
    durationMs: 0,
    requestCount: 0,
    storedRecords: 0,
    deletedRecords: 0,
    scannedKeys: 0,
    committedBatches: 0,
    abortedTransactions: 0
  };
  const write = async () => {
    const totalRecords = Object.values(batch).reduce((total, records) => total + records.length, 0);
    const startedAt = performance.now();
    const result = await upsertCanonicalBatch(indexedDB, batch, {
      validateRelationships: false,
      signal: options.signal,
      onBatchCommitted: ({ committedBatches, committedRecords }) => {
        options.onWriteProgress?.({ storedRecords: committedRecords, totalRecords });
        writeMetrics = {
          ...writeMetrics,
          durationMs: performance.now() - startedAt,
          requestCount: committedRecords,
          storedRecords: committedRecords,
          committedBatches
        };
      }
    });
    if (totalRecords === 0) options.onWriteProgress?.({ storedRecords: 0, totalRecords: 0 });
    writeMetrics = {
      ...writeMetrics,
      durationMs: performance.now() - startedAt,
      requestCount: result.committedRecords,
      storedRecords: result.committedRecords,
      committedBatches: result.committedBatches
    };
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
      options.signal?.throwIfAborted();
      const reduced = capCanonicalBatchSize(batch, Math.floor(estimateCanonicalBatchBytes(batch) * 0.5));
      if (reduced.runs.length === batch.runs.length) throw error;
      await maintainCanonicalDatabase(indexedDB, {
        now: options.now,
        retentionWindowMs: options.retentionWindowMs,
        retentionWindowMsByStore: options.retentionWindowMsByStore,
        maxDatabaseBytes: Math.floor(maxDatabaseBytes * 0.5),
        reconcileRelationships: true,
        preserveEntityIds: {
          repositories: batch.repositories.map((record) => String(record.id)),
          workflows: batch.workflows.map((record) => String(record.id))
        }
      });
      debug('retrying canonical write after quota pressure', {
        attempt: attempt + 1,
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
      databaseUsage = await inspectDatabaseUsage(options.storage).catch(() => null);
      if (databaseUsage === null || databaseUsage <= maxDatabaseBytes || batch.runs.length === 0) break;
      debug('shrinking canonical batch after storage usage check', {
        attempt: attempt + 1,
        databaseUsage,
        maxDatabaseBytes
      });
      const maintenance = await maintainCanonicalDatabase(indexedDB, {
        now: options.now,
        retentionWindowMs: options.retentionWindowMs,
        retentionWindowMsByStore: options.retentionWindowMsByStore,
        maxDatabaseBytes,
        usageBytes: databaseUsage,
        reconcileRelationships: true,
        preserveEntityIds: {
          repositories: batch.repositories.map((record) => String(record.id)),
          workflows: batch.workflows.map((record) => String(record.id))
        }
      });
      writeMetrics.deletedRecords += maintenance.deletedRecords;
    }
  }
  const maintenance = await maintainCanonicalDatabase(indexedDB, {
    now: options.now,
    retentionWindowMs: options.retentionWindowMs,
    retentionWindowMsByStore: options.retentionWindowMsByStore,
    maxDatabaseBytes,
    usageBytes: databaseUsage,
    reconcileRelationships: true,
    preserveEntityIds: {
      repositories: batch.repositories.map((record) => String(record.id)),
      workflows: batch.workflows.map((record) => String(record.id))
    }
  });
  writeMetrics.deletedRecords += maintenance.deletedRecords;
  const runs = await readCollection(indexedDB, 'runs');
  const runsOnlyBatch = /** @type {import('../model/schema.js').CanonicalBatch} */ ({
    ...Object.fromEntries(ENTITY_STORES.map((storeName) => [storeName, []])),
    runs
  });
  await publishDailyOverviewAggregatesForBatch(indexedDB, runsOnlyBatch);
  return {
    updated: true,
    committedBatches: 0,
    committedRecords: maintenance.retainedRecords,
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
 * Applies retention and size limits for a normalized JSONL ingestion using the
 * caller's configured windows and storage estimate.
 *
 * @param {IDBFactory} indexedDB
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number }} options
 */
async function maintainNormalizedJsonlDatabase(indexedDB, options) {
  const maxDatabaseBytes = Number.isFinite(options.maxDatabaseBytes)
    ? Math.max(0, Number(options.maxDatabaseBytes))
    : MAX_DASHBOARD_DATABASE_BYTES;
  const usageBytes = options.storage
    ? await inspectDatabaseUsage(options.storage).catch(() => null)
    : null;
  return maintainCanonicalDatabase(indexedDB, {
    now: options.now,
    retentionWindowMs: options.retentionWindowMs,
    retentionWindowMsByStore: options.retentionWindowMsByStore,
    maxDatabaseBytes,
    usageBytes
  });
}

/**
 * Runs the retention and size maintenance pass that `ingestNormalizedJsonl`
 * skips when called with `deferMaintenance`.
 *
 * Maintenance cursor-scans every canonical store and re-estimates the size of
 * each retained record, so its cost scales with the whole database rather than
 * with the shard just written. Callers that ingest a batch of shards must defer
 * it and invoke this once afterwards; running it per shard makes a multi-shard
 * import quadratic in the number of shards.
 *
 * @param {IDBFactory} indexedDB
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, onLockWait?: () => void, signal?: AbortSignal }} options
 */
export function finalizeNormalizedJsonlIngestion(indexedDB, options = {}) {
  return serializeIngestion(
    indexedDB,
    () => maintainNormalizedJsonlDatabase(indexedDB, options),
    { onLockWait: options.onLockWait, signal: options.signal }
  );
}

/**
 * Streams build-time normalized activity JSONL into canonical storage without
 * retaining the full transport shard in memory.
 *
 * @param {IDBFactory} indexedDB
 * @param {AsyncIterable<string | Uint8Array>} chunks
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, deferMaintenance?: boolean, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, onLockWait?: () => void, payloadIdentity: string, payloadScope: string, expectedPhase?: 'runs' | 'records', signal?: AbortSignal }} options
 */
export function ingestNormalizedJsonl(indexedDB, chunks, options) {
  return serializeIngestion(indexedDB, async () => {
    let phase = 'adapting';
    try {
      if (!chunks || typeof chunks !== 'object' || !(Symbol.asyncIterator in chunks)) {
        throw new TypeError('Normalized activity JSONL must be an async iterable');
      }
      if (await isNormalizedJsonlCurrent(indexedDB, options)) {
        debug('skipped unchanged normalized activity JSONL shard', { scope: options.payloadScope });
        return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
      }
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = '';
      let lineNumber = 0;
      /** @type {{ phase: 'all' | 'runs' | 'records', records: number, sourceRecords?: number } | null} */
      let header = null;
      let batch = emptyNormalizedBatch();
      let bufferedRecords = 0;
      let committedBatches = 0;
      let committedRecords = 0;
      let rawRuns = 0;
      const flush = async () => {
        if (bufferedRecords === 0) return;
        phase = 'writing';
        await preserveStreamedStructuralMetadata(indexedDB, batch);
        const result = await upsertCanonicalBatch(indexedDB, batch, {
          validateRelationships: false,
          onBatchCommitted: ({ committedRecords: storedRecords }) => {
            options.onWriteProgress?.({
              storedRecords: committedRecords + storedRecords,
              totalRecords: Number(header?.records ?? committedRecords + bufferedRecords)
            });
          }
        });
        committedBatches += result.committedBatches;
        committedRecords += result.committedRecords;
        batch = emptyNormalizedBatch();
        bufferedRecords = 0;
        phase = 'adapting';
      };
      /** @param {string} line */
      const accept = async (line) => {
        lineNumber += 1;
        if (!line.trim()) return;
        /** @type {Record<string, unknown>} */
        let envelope;
        try {
          envelope = JSON.parse(line);
        } catch (error) {
          throw new TypeError(`Normalized activity JSONL line ${lineNumber} must contain valid JSON`, { cause: error });
        }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
          throw new TypeError(`Normalized activity JSONL line ${lineNumber} must contain an object`);
        }
        if (!header) {
          if (envelope.kind !== 'metadata') {
            throw new TypeError('Normalized activity JSONL must start with metadata');
          }
          const schemaVersion = Number(envelope.schemaVersion);
          if (schemaVersion !== CANONICAL_SCHEMA_VERSION) {
            throw new TypeError(`Unsupported normalized activity schema: ${String(envelope.schemaVersion)}`);
          }
          if (envelope.ingestionVersion !== NORMALIZED_JSONL_INGESTION_VERSION) {
            throw new TypeError(`Unsupported normalized activity ingestion version: ${String(envelope.ingestionVersion)}`);
          }
          if (typeof envelope.phase !== 'string'
              || !['all', 'runs', 'records'].includes(envelope.phase)) {
            throw new TypeError(`Unsupported normalized activity phase: ${String(envelope.phase)}`);
          }
          if (options.expectedPhase && envelope.phase !== options.expectedPhase) {
            throw new TypeError(`Normalized activity payload phase must be ${options.expectedPhase}`);
          }
          if (!Number.isSafeInteger(envelope.records) || Number(envelope.records) < 0) {
            throw new TypeError('Normalized activity JSONL metadata records must be a non-negative integer');
          }
          header = {
            phase: /** @type {'all' | 'runs' | 'records'} */ (envelope.phase),
            records: Number(envelope.records),
            sourceRecords: Number.isSafeInteger(envelope.sourceRecords)
              ? Number(envelope.sourceRecords)
              : undefined
          };
          return;
        }
        const collection = typeof envelope.collection === 'string'
          ? /** @type {typeof NORMALIZED_BATCH_COLLECTIONS[number]} */ (envelope.collection)
          : null;
        if (envelope.kind !== 'record'
            || collection === null
            || !NORMALIZED_BATCH_COLLECTIONS.includes(collection)
            || !envelope.record
            || typeof envelope.record !== 'object'
            || Array.isArray(envelope.record)) {
          throw new TypeError(`Normalized activity JSONL line ${lineNumber} must contain a canonical record`);
        }
        const excluded = header.phase === 'runs'
          ? ['domains', 'tools', 'audits', 'issues', 'operationalValues']
          : header.phase === 'records'
            ? ['campaigns', 'repositories', 'workflows', 'runs']
            : [];
        if (excluded.includes(collection)) {
          throw new TypeError(`Normalized ${header.phase} payload must not include ${collection}`);
        }
        if (collection === 'runs') rawRuns += 1;
        batch[collection].push(/** @type {never} */ (envelope.record));
        bufferedRecords += 1;
        if (bufferedRecords >= NORMALIZED_JSONL_WRITE_BATCH_SIZE) await flush();
      };
      for await (const chunk of chunks) {
        options.signal?.throwIfAborted();
        pending += decoder.decode(typeof chunk === 'string' ? encoder.encode(chunk) : chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          await accept(line);
        }
      }
      pending += decoder.decode();
      if (pending) await accept(pending);
      const metadata = /** @type {{ phase: 'all' | 'runs' | 'records', records: number, sourceRecords?: number } | null} */ (header);
      if (!metadata) throw new TypeError('Normalized activity JSONL metadata is missing');
      await flush();
      if (committedRecords !== metadata.records) {
        throw new TypeError(
          `Normalized activity JSONL declared ${metadata.records} records but contained ${committedRecords}`
        );
      }
      options.signal?.throwIfAborted();
      const retained = options.deferMaintenance
        ? null
        : await maintainNormalizedJsonlDatabase(indexedDB, options);
      const result = { updated: true, committedBatches, committedRecords };
      await recordTransaction(indexedDB, {
        id: normalizedJsonlShardTransactionId(options.payloadIdentity),
        kind: 'ingest-normalized-jsonl',
        createdAt: new Date(options.now ?? Date.now()).toISOString(),
        payloadScope: options.payloadScope,
        payloadHash: options.payloadIdentity,
        ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
        records: Number(metadata.sourceRecords ?? 0),
        committedRecords,
        rawRuns,
        ...(retained === null ? { maintenanceDeferred: true } : { storage: retained })
      });
      return { ...result, records: Number(metadata.sourceRecords ?? 0) };
    } catch (error) {
      if (error instanceof CanonicalIngestionError) throw error;
      throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
    }
  }, { onLockWait: options.onLockWait, signal: options.signal });
}

function emptyNormalizedBatch() {
  return /** @type {import('../model/schema.js').CanonicalBatch} */ (
    /** @type {unknown} */ (Object.fromEntries(NORMALIZED_BATCH_COLLECTIONS.map((collection) => [collection, []])))
  );
}

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 */
async function preserveStreamedStructuralMetadata(indexedDB, batch) {
  for (const storeName of /** @type {const} */ (['repositories', 'workflows'])) {
    batch[storeName] = await Promise.all(batch[storeName].map(async (record) => (
      mergeActivityStructuralRecord(
        storeName,
        await readRecord(indexedDB, storeName, String(record.id)) ?? undefined,
        record
      )
    )));
  }
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
      const current = await readCachedJsonlShardReceipt(indexedDB, publishedIdentity);
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
      : await readCachedJsonlShardReceipt(indexedDB, payloadIdentity);
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
      id: cachedJsonlShardTransactionId(payloadIdentity),
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
