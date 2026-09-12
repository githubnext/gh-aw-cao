import { adaptDashboardSources } from '../adapters/dashboard-sources.js';
import { adaptCachedGhAwJsonl, adaptGhAwLogs } from '../adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../adapters/sql-export.js';
import { normalize } from '../normalize/index.js';
import {
  readCanonicalBatch,
  readTransaction,
  recordTransaction,
  replaceCanonicalBatch
} from '../storage/indexeddb.js';
import { capCanonicalBatchSize, estimateCanonicalBatchBytes, mergeRetainedRecords } from '../storage/retention.js';
import {
  inspectDatabaseUsage,
  inspectStorage,
  MAX_DASHBOARD_DATABASE_BYTES,
  requestPersistentStorage
} from '../storage/quota.js';
import { CanonicalIngestionError, classifyIngestionError } from './errors.js';

/**
 * @param {unknown} payload
 * @param {string | undefined} identity
 */
async function payloadHash(payload, identity) {
  const value = identity ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const hashes = Array.from({ length: 8 }, (_, index) => (0x811c9dc5 ^ (index * 0x9e3779b9)) >>> 0);
  for (let offset = 0; offset < value.length; offset += 1) {
    for (let index = 0; index < hashes.length; index += 1) {
      hashes[index] = Math.imul(hashes[index] ^ value.charCodeAt(offset), 0x01000193 + (index * 2)) >>> 0;
    }
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, '0')).join('');
}

/** @param {IDBFactory} indexedDB @param {string} kind @param {string} hash */
async function previouslyIngested(indexedDB, kind, hash) {
  return await readTransaction(indexedDB, `${kind}:${hash}`) !== null;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number }} options
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
    retentionWindowMsByStore: options.retentionWindowMsByStore
  }), targetDatabaseBytes);
  for (;;) {
    try {
      await replaceCanonicalBatch(indexedDB, batch);
      break;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
      const reduced = capCanonicalBatchSize(batch, Math.floor(estimateCanonicalBatchBytes(batch) * 0.75));
      if (reduced.runs.length === batch.runs.length) throw error;
      batch = reduced;
    }
  }
  if (options.storage) {
    for (;;) {
      const databaseUsage = await inspectDatabaseUsage(options.storage).catch(() => null);
      if (databaseUsage === null || databaseUsage <= maxDatabaseBytes || batch.runs.length === 0) break;
      const target = Math.floor(estimateCanonicalBatchBytes(batch) * (maxDatabaseBytes / databaseUsage) * 0.9);
      const reduced = capCanonicalBatchSize(batch, target);
      if (reduced.runs.length === batch.runs.length) break;
      batch = reduced;
      await replaceCanonicalBatch(indexedDB, batch);
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
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, payloadIdentity?: string }} [options]
 */
export async function ingestDashboardSources(indexedDB, sources, options = {}) {
  let phase = 'adapting';
  try {
    const hash = await payloadHash(sources, options.payloadIdentity);
    if (await previouslyIngested(indexedDB, 'ingest-dashboard-sources', hash)) {
      return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
    }
    const adapted = adaptDashboardSources(sources);
    phase = 'normalizing';
    const batch = normalize(adapted.observations);
    phase = 'writing';
    const result = await ingestCanonicalBatch(indexedDB, batch, options);
    await recordTransaction(indexedDB, {
      id: `ingest-dashboard-sources:${hash}`,
      kind: 'ingest-dashboard-sources',
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      payloadHash: hash,
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
    return await ingestCanonicalBatch(indexedDB, batch, options);
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, error);
  }
}

/**
 * Incrementally upserts schema-v2 gh-aw cached JSONL into canonical storage.
 * @param {IDBFactory} indexedDB
 * @param {string} content
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes?: number, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], payloadIdentity?: string }} [options]
 */
export async function ingestCachedGhAwJsonl(indexedDB, content, options = {}) {
  const createdAt = new Date(options.now ?? Date.now()).toISOString();
  try {
    const hash = await payloadHash(content, options.payloadIdentity);
    if (await previouslyIngested(indexedDB, 'ingest-jsonl', hash)) {
      return { updated: false, skipped: true, committedBatches: 0, committedRecords: 0 };
    }
    const adapted = adaptCachedGhAwJsonl(content, {
      context: options.context,
      workflowHints: options.workflowHints
    });
    const result = await ingestCanonicalBatch(indexedDB, normalize(adapted.observations), options);
    await recordTransaction(indexedDB, {
      id: `ingest-jsonl:${hash}`,
      kind: 'ingest-jsonl',
      createdAt,
      payloadHash: hash,
      records: adapted.records,
      committedRecords: result.committedRecords,
      rawPayloadRecords: adapted.rawPayloadRecords,
      rawRuns: adapted.rawRuns,
      agenticRunRecords: adapted.agenticRunRecords,
      agenticRuns: adapted.agenticRuns,
      duplicateRawRunObservations: adapted.duplicateRawRunObservations,
      duplicateAgenticRunObservations: adapted.duplicateAgenticRunObservations,
      unenrichedRuns: adapted.unenrichedRuns
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
      mappedRateLimits: adapted.mappedRateLimits
    };
  } catch (error) {
    await recordTransaction(indexedDB, {
      id: `ingest-jsonl-failed:${createdAt}`,
      kind: 'ingest-jsonl-failed',
      createdAt,
      error: error instanceof Error ? error.name : 'Error'
    }).catch(() => undefined);
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, 'adapting'), 'adapting', error);
  }
}
