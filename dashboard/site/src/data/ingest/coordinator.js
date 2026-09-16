import { adaptDashboardSources } from '../adapters/dashboard-sources.js';
import {
  adaptCachedGhAwJsonl,
  adaptCachedGhAwJsonlStream,
  adaptGhAwLogs,
  cachedJsonlPayloadIdentity
} from '../adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../adapters/sql-export.js';
import { normalize } from '../normalize/index.js';
import {
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

const DASHBOARD_SOURCE_INGESTION_VERSION = 3;
const GH_AW_JSONL_INGESTION_VERSION = 2;
const MAX_QUOTA_RECOVERY_ATTEMPTS = 4;
const MAX_USAGE_RECOVERY_ATTEMPTS = 4;
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

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

/** @template T @param {IDBFactory} indexedDB @param {() => Promise<T>} task */
function serializeIngestion(indexedDB, task) {
  const lockedTask = () => withCanonicalIngestionLock(indexedDB, task);
  const result = ingestionQueue.then(lockedTask, lockedTask);
  ingestionQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, preserveWorkflowPackageMappings?: boolean, preserveRepositoryRecords?: boolean, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void }} options
 */
async function ingestCanonicalBatch(indexedDB, incoming, options) {
  if (options.storage) {
    await Promise.allSettled([
      inspectStorage(options.storage),
      requestPersistentStorage(options.storage)
    ]);
  }
  const retained = await readCanonicalBatch(indexedDB);
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
    preserveWorkflowPackageMappings: options.preserveWorkflowPackageMappings,
    preserveRepositoryRecords: options.preserveRepositoryRecords
  }), targetDatabaseBytes);
  const write = () => replaceCanonicalBatch(indexedDB, batch, {
    onProgress: options.onWriteProgress,
    previousBatch: retained
  });
  // Every write of a large batch costs minutes in a constrained browser, so
  // recovery halves the batch a bounded number of times and then reports the
  // quota failure instead of retrying until the tab looks stuck.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await write();
      break;
    } catch (error) {
      if (!isQuotaExceededError(error) || attempt >= MAX_QUOTA_RECOVERY_ATTEMPTS) throw error;
      const reduced = capCanonicalBatchSize(batch, Math.floor(estimateCanonicalBatchBytes(batch) * 0.5));
      if (reduced.runs.length === batch.runs.length) throw error;
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
      batch = reduced;
      await write();
    }
  }
  return {
    updated: true,
    committedBatches: 0,
    committedRecords: Object.values(batch).reduce((total, records) => total + records.length, 0)
  };
}

/**
 * Upserts the current published source document onto retained canonical records.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, payloadIdentity?: string, payloadScope?: string, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void }} [options]
 */
export function ingestDashboardSources(indexedDB, sources, options = {}) {
  return serializeIngestion(indexedDB, () => ingestDashboardSourcesNow(indexedDB, sources, options));
}

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, payloadIdentity?: string, payloadScope?: string, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void }} options
 */
async function ingestDashboardSourcesNow(indexedDB, sources, options) {
  let phase = 'adapting';
  try {
    const hash = await payloadHash(sources, options.payloadIdentity);
    const scope = options.payloadScope ?? 'dashboard-sources';
    if (await previouslyIngested(
      indexedDB,
      'ingest-dashboard-sources',
      scope,
      hash,
      DASHBOARD_SOURCE_INGESTION_VERSION
    )) {
      return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
    }
    const adapted = adaptDashboardSources(sources);
    phase = 'normalizing';
    const batch = normalize(adapted.observations);
    phase = 'writing';
    const result = await ingestCanonicalBatch(indexedDB, batch, options);
    await recordTransaction(indexedDB, {
      id: await transactionId('ingest-dashboard-sources', scope),
      kind: 'ingest-dashboard-sources',
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      payloadScope: scope,
      payloadHash: hash,
      ingestionVersion: DASHBOARD_SOURCE_INGESTION_VERSION,
      committedRecords: result.committedRecords
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
      preserveWorkflowPackageMappings: true,
      preserveRepositoryRecords: true
    });
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}

/**
 * Incrementally upserts schema-v2 gh-aw cached JSONL into canonical storage.
 * @param {IDBFactory} indexedDB
 * @param {string | Uint8Array | AsyncIterable<string | Uint8Array>} content
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], onProgress?: (progress: { bytesProcessed: number, linesProcessed: number, recordsIngested: number }) => void, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, payloadIdentity?: string, payloadEtag?: string, payloadScope?: string }} [options]
 */
export function ingestCachedGhAwJsonl(indexedDB, content, options = {}) {
  return serializeIngestion(indexedDB, () => ingestCachedGhAwJsonlNow(indexedDB, content, options));
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string | Uint8Array | AsyncIterable<string | Uint8Array>} content
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], onProgress?: (progress: { bytesProcessed: number, linesProcessed: number, recordsIngested: number }) => void, onWriteProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, payloadIdentity?: string, payloadEtag?: string, payloadScope?: string }} options
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
    const adaptationContext = cachedJsonlAdaptationContext(options);
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
    const scope = options.payloadScope ?? 'gh-aw-jsonl';
    const current = await readCurrentIngestion(indexedDB, 'ingest-jsonl', scope);
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
    const normalizationMs = monotonicNow() - normalizationStartedAt;
    debug('normalized JSONL stream', {
      sourceRecords: adapted.records,
      runs: batch.runs.length,
      sessions: batch.sessions.length,
      events: batch.events.length
    });
    phase = 'writing';
    const storageStartedAt = monotonicNow();
    const result = await ingestCanonicalBatch(indexedDB, batch, {
      ...options,
      preserveWorkflowPackageMappings: true,
      preserveRepositoryRecords: true
    });
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
      sessions: adapted.sessions,
      events: adapted.events,
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
