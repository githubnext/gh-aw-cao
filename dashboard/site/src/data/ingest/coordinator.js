import { adaptDashboardSources } from '../adapters/dashboard-sources.js';
import { adaptCachedGhAwJsonl, adaptGhAwLogs } from '../adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../adapters/sql-export.js';
import { normalize } from '../normalize/index.js';
import { readCanonicalBatch, recordTransaction, replaceCanonicalBatch } from '../storage/indexeddb.js';
import { mergeRetainedRecords } from '../storage/retention.js';
import { inspectStorage, requestPersistentStorage } from '../storage/quota.js';
import { CanonicalIngestionError, classifyIngestionError } from './errors.js';

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} incoming
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number> }} options
 */
async function ingestCanonicalBatch(indexedDB, incoming, options) {
  if (options.storage) {
    await Promise.allSettled([
      inspectStorage(options.storage),
      requestPersistentStorage(options.storage)
    ]);
  }
  const retained = await readCanonicalBatch(indexedDB);
  const batch = mergeRetainedRecords(retained, incoming, {
    now: options.now,
    retentionWindowMs: options.retentionWindowMs,
    retentionWindowMsByStore: options.retentionWindowMsByStore
  });
  await replaceCanonicalBatch(indexedDB, batch);
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
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number> }} [options]
 */
export async function ingestDashboardSources(indexedDB, sources, options = {}) {
  let phase = 'adapting';
  try {
    const adapted = adaptDashboardSources(sources);
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
 * Upserts one complete SQL export onto retained canonical records.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number> }} [options]
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
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number> }} [options]
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
 * @param {{ storage?: StorageManager, now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} [options]
 */
export async function ingestCachedGhAwJsonl(indexedDB, content, options = {}) {
  const createdAt = new Date(options.now ?? Date.now()).toISOString();
  try {
    const adapted = adaptCachedGhAwJsonl(content, {
      context: options.context,
      workflowHints: options.workflowHints
    });
    const result = await ingestCanonicalBatch(indexedDB, normalize(adapted.observations), options);
    await recordTransaction(indexedDB, {
      id: `ingest-jsonl:${createdAt}:${adapted.records}`,
      kind: 'ingest-jsonl',
      createdAt,
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
