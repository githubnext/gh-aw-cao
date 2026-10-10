import { EVIDENCE_DEFINITION_STORES, mergeEvidenceDefinition } from '../model/schema.js';
import {
  auditCurationRunFacts, discardAudit, AUDIT_CURATION_TRANSACTION_ID, AUDIT_CURATION_VERSION
} from '../model/audit-curation.js';
import { recordTimestamp, RETENTION_TIMESTAMPS, retentionWindowForStore } from './retention.js';
import { createDebug } from '../../debug.js';

const debug = createDebug('data:retention');
export const STORAGE_SHARD_STORE = 'storageShards';
const TOTALS_ID = 'totals';
const BATCH_SIZE = 1000;
const DAY_MS = 86400000;

/** @typedef {{ shard: string, timestamp: number, bytes: number }} StorageMetadata */
/** @typedef {{ id: string, storeName?: string, day?: number, bytes: number, count: number, dirty?: boolean, runId?: string, auditId?: string }} Shard */

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage shard request failed'));
  });
}

/** @param {IDBTransaction} transaction */
function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('Storage shard transaction aborted'));
  });
}

/** @param {Record<string, unknown>} record */
export function withoutStorageMetadata(record) {
  const canonical = { ...record };
  delete canonical._storage;
  delete canonical._queryKeys;
  return canonical;
}

/** @param {string} storeName @param {Record<string, unknown>} record */
export function withStorageMetadata(storeName, record) {
  const stored = { ...record };
  delete stored._storage;
  const timestamp = recordTimestamp(storeName, stored) ?? -Number.MAX_SAFE_INTEGER;
  const day = Object.hasOwn(RETENTION_TIMESTAMPS, storeName)
    ? Math.floor(timestamp / DAY_MS) : 0;
  return {
    ...stored,
    _storage: {
      shard: `${storeName}:${day}`,
      timestamp,
      bytes: new TextEncoder().encode(JSON.stringify(stored)).byteLength + 512
    }
  };
}

/** @param {Record<string, unknown>} record @returns {StorageMetadata} */
function metadata(record) {
  const value = /** @type {StorageMetadata | undefined} */ (record._storage);
  if (!value || typeof value.shard !== 'string' || !Number.isFinite(value.timestamp)
      || !Number.isFinite(value.bytes) || value.bytes < 0) {
    throw new Error('Canonical record is missing valid storage shard metadata; rebuild the derived database');
  }
  return value;
}

/**
 * Updates records and their shard/total accounting in the same transaction.
 * Duplicate IDs in a transport batch count as one stored record.
 * @param {IDBTransaction} transaction
 * @param {string} storeName
 * @param {Record<string, unknown>[]} records
 * @param {Record<string, unknown>[]} [removed]
 */
export async function writeAccountedRecords(transaction, storeName, records, removed = []) {
  const store = transaction.objectStore(storeName);
  const shards = transaction.objectStore(STORAGE_SHARD_STORE);
  const unique = new Map();
  for (const record of records) {
    const previous = unique.get(String(record.id));
    unique.set(String(record.id), previous && EVIDENCE_DEFINITION_STORES.has(storeName)
      ? withStorageMetadata(storeName, mergeEvidenceDefinition(
          withoutStorageMetadata(previous), withoutStorageMetadata(record)
        ))
      : record);
  }
  const incoming = [...unique.values()];
  const previous = await Promise.all(incoming.map((record) =>
    result(store.get(/** @type {IDBValidKey} */ (record.id)))));
  /** @type {Map<string, Shard>} */
  const deltas = new Map();
  /** @type {string[]} */
  const dirtyRuns = [];
  const dirtyAudits = new Set();
  const referencesAudits = ['experimentAssignments', 'graderObservations', 'evalObservations'].includes(storeName);
  /** @param {Record<string, unknown>} record @param {number} sign */
  const account = (record, sign) => {
    const stored = metadata(record);
    const delta = deltas.get(stored.shard) ?? {
      id: stored.shard, storeName, day: Object.hasOwn(RETENTION_TIMESTAMPS, storeName)
        ? Math.floor(stored.timestamp / DAY_MS) : 0, bytes: 0, count: 0
    };
    delta.bytes += sign * stored.bytes;
    delta.count += sign;
    if (storeName === 'audits' && sign > 0) delta.dirty = true;
    deltas.set(delta.id, delta);
  };
  for (const record of removed) {
    account(record, -1);
    if (referencesAudits && typeof record.auditId === 'string') dirtyAudits.add(record.auditId);
  }
  incoming.forEach((record, index) => {
    const existing = previous[index];
    if (existing) account(existing, -1);
    if (referencesAudits && typeof existing?.auditId === 'string' && existing.auditId !== record.auditId) {
      dirtyAudits.add(existing.auditId);
    }
    if (EVIDENCE_DEFINITION_STORES.has(storeName)) {
      record = withStorageMetadata(storeName, mergeEvidenceDefinition(
        existing ? withoutStorageMetadata(existing) : undefined, withoutStorageMetadata(record)
      ));
    }
    account(record, 1);
    if (storeName === 'runs' && existing && JSON.stringify(auditCurationRunFacts(existing))
        !== JSON.stringify(auditCurationRunFacts(record))) dirtyRuns.push(String(record.id));
    store.put(record);
  });
  for (const record of removed) store.delete(/** @type {IDBValidKey} */ (record.id));
  if (deltas.size === 0) return;
  const changes = [...deltas.values()];
  const existing = await Promise.all([TOTALS_ID, ...changes.map(({ id }) => id)]
    .map((id) => result(shards.get(id))));
  const totals = /** @type {Shard} */ (existing[0] ?? { id: TOTALS_ID, bytes: 0, count: 0 });
  changes.forEach((delta, index) => {
    const previous = /** @type {Shard | undefined} */ (existing[index + 1]);
    const next = {
      ...previous, ...delta,
      dirty: Boolean(previous?.dirty || delta.dirty),
      bytes: (previous?.bytes ?? 0) + delta.bytes,
      count: (previous?.count ?? 0) + delta.count
    };
    if (next.bytes < 0 || next.count < 0) throw new Error('Canonical storage shard accounting is inconsistent');
    if (next.count === 0) shards.delete(next.id);
    else shards.put(next);
    totals.bytes += delta.bytes;
    totals.count += delta.count;
  });
  if (totals.bytes < 0 || totals.count < 0) throw new Error('Canonical storage totals are inconsistent');
  shards.put(totals);
  for (const runId of dirtyRuns) shards.put({
    id: `curation:${runId}`, runId, bytes: 0, count: 0
  });
  for (const auditId of dirtyAudits) shards.put({
    id: `audit-curation:${auditId}`, auditId, bytes: 0, count: 0
  });
}

/**
 * @template T
 * @param {IDBDatabase} database
 * @param {string[]} stores
 * @param {(transaction: IDBTransaction) => Promise<T>} task
 */
async function write(database, stores, task) {
  const transaction = database.transaction([...new Set([...stores, STORAGE_SHARD_STORE])], 'readwrite');
  const done = completed(transaction);
  try {
    const value = await task(transaction);
    await done;
    return value;
  } catch (error) {
    try { transaction.abort(); } catch { /* Already aborted or completed. */ }
    await done.catch(() => undefined);
    throw error;
  }
}

/** @param {IDBDatabase} database @param {{ signal?: AbortSignal }} options @returns {Promise<Shard[]>} */
async function readShards(database, options) {
  /** @type {Shard[]} */
  const shards = [];
  /** @type {IDBKeyRange | undefined} */
  let range;
  for (;;) {
    options.signal?.throwIfAborted();
    const rows = /** @type {Shard[]} */ (await result(database.transaction(STORAGE_SHARD_STORE)
      .objectStore(STORAGE_SHARD_STORE).getAll(range, BATCH_SIZE)));
    if (rows.some((shard) => typeof shard.id !== 'string' || !Number.isFinite(shard.bytes)
        || shard.bytes < 0 || !Number.isInteger(shard.count) || shard.count < 0
        || (shard.storeName !== undefined && !Number.isFinite(shard.day)))) {
      throw new Error('Canonical storage shard accounting is invalid; rebuild the derived database');
    }
    shards.push(...rows);
    if (rows.length < BATCH_SIZE) {
      const totals = shards.find(({ id }) => id === TOTALS_ID);
      const entities = shards.filter(({ storeName }) => storeName !== undefined);
      if (!totals && entities.length > 0) {
        throw new Error('Canonical storage shard totals are missing; rebuild the derived database');
      }
      if (totals && (totals.bytes !== entities.reduce((sum, shard) => sum + shard.bytes, 0)
          || totals.count !== entities.reduce((sum, shard) => sum + shard.count, 0))) {
        throw new Error('Canonical storage shard totals are inconsistent; rebuild the derived database');
      }
      return shards;
    }
    range = IDBKeyRange.lowerBound(rows.at(-1)?.id, true);
  }
}

/**
 * @param {IDBDatabase} database
 * @param {string} storeName
 * @param {string} indexName
 * @param {IDBKeyRange} range
 * @param {{ signal?: AbortSignal }} options
 */
async function deleteRange(database, storeName, indexName, range, options) {
  let deleted = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const count = await write(database, [storeName], async (transaction) => {
      const records = await result(transaction.objectStore(storeName).index(indexName).getAll(range, BATCH_SIZE));
      await writeAccountedRecords(transaction, storeName, [], records);
      return records.length;
    });
    deleted += count;
    if (count < BATCH_SIZE) return deleted;
  }
}

/**
 * @param {IDBDatabase} database
 * @param {Record<string, unknown>} run
 * @param {{ runLinkedStores: readonly string[], signal?: AbortSignal }} options
 */
async function deleteRun(database, run, options) {
  let deleted = 0;
  for (const storeName of options.runLinkedStores) {
    deleted += await deleteRange(database, storeName, 'byStorageRun',
      IDBKeyRange.bound([run.id], [run.id, []]), options);
  }
  await write(database, ['runs'], (transaction) => writeAccountedRecords(transaction, 'runs', [], [run]));
  return deleted + 1;
}

/**
 * Curation reads only newly written audit shards or audits belonging to changed
 * runs. Reference indexes keep evidence checks scoped to each candidate audit.
 * @param {IDBDatabase} database
 * @param {Shard[]} shards
 * @param {{ signal?: AbortSignal }} options
 */
async function curateDirtyAudits(database, shards, options) {
  const referenceStores = ['graderObservations', 'evalObservations', 'experimentAssignments'];
  let pruned = 0;
  for (const shard of shards.filter((shard) => shard.dirty || shard.runId || shard.auditId)) {
    const indexName = shard.runId ? 'byStorageRun' : 'byStorageTimestamp';
    const key = shard.runId ?? shard.auditId ?? shard.id;
    /** @type {IDBKeyRange} */
    let range = shard.runId || shard.auditId ? IDBKeyRange.bound([key], [key, []])
      : IDBKeyRange.bound([Number(shard.day) * DAY_MS], [(Number(shard.day) + 1) * DAY_MS], false, true);
    for (;;) {
      options.signal?.throwIfAborted();
      const page = await write(database, ['audits', 'runs', ...referenceStores], async (transaction) => {
        const store = transaction.objectStore('audits');
        const audit = shard.auditId ? await result(store.get(shard.auditId)) : undefined;
        const audits = shard.auditId ? (audit ? [audit] : [])
          : await result(store.index(indexName).getAll(range, BATCH_SIZE));
        const runIds = [...new Set(audits.map((audit) => String(audit.runId)))];
        const runFacts = await Promise.all(runIds.map((id) => result(transaction.objectStore('runs').get(id))));
        const runs = new Map(runIds.map((id, index) => [id, runFacts[index]]));
        const candidates = audits.filter((audit) => discardAudit(
          withoutStorageMetadata(audit), runs.get(String(audit.runId))
        ));
        const references = await Promise.all(candidates.map((audit) => Promise.all(referenceStores.map(
          (storeName) => result(transaction.objectStore(storeName).index('byAudit').count(audit.id))
        ))));
        const removed = candidates.filter((_, index) => references[index].every((count) => count === 0));
        await writeAccountedRecords(transaction, 'audits', [], removed);
        return { audits, removed: removed.length };
      });
      pruned += page.removed;
      if (page.audits.length < BATCH_SIZE) break;
      const last = page.audits.at(-1);
      range = shard.runId ? IDBKeyRange.bound([key, last?.id], [key, []], true)
        : IDBKeyRange.bound([metadata(/** @type {Record<string, unknown>} */ (last)).timestamp, last?.id],
            [(Number(shard.day) + 1) * DAY_MS], true, true);
    }
    await write(database, [], async (transaction) => {
      const store = transaction.objectStore(STORAGE_SHARD_STORE);
      if (shard.runId || shard.auditId) store.delete(shard.id);
      else {
        const current = await result(store.get(shard.id));
        if (current) store.put({ ...current, dirty: false });
      }
    });
  }
  return pruned;
}

/**
 * @param {IDBDatabase} database
 * @param {Parameters<import('./indexeddb.js').maintainCanonicalDatabase>[1] & {
 * entityStores: readonly string[], runLinkedStores: readonly string[]
 * }} options
 */
export async function maintainStorageShards(database, options) {
  const startedAt = performance.now();
  const now = options.now ?? Date.now();
  let deletedRecords = 0;
  let shards = await readShards(database, options);
  for (const [index, storeName] of options.entityStores.entries()) {
    options.signal?.throwIfAborted();
    if (Object.hasOwn(RETENTION_TIMESTAMPS, storeName)) {
      const horizon = now - retentionWindowForStore(storeName, options);
      const expired = shards.filter((shard) => shard.storeName === storeName
        && Number(shard.day) * DAY_MS < horizon);
      if (storeName === 'runs' && expired.length > 0) {
        for (;;) {
          options.signal?.throwIfAborted();
          const runs = await result(database.transaction('runs').objectStore('runs')
            .index('byStorageTimestamp').getAll(IDBKeyRange.upperBound([horizon], true), BATCH_SIZE));
          for (const run of runs) deletedRecords += await deleteRun(database, run, options);
          if (runs.length < BATCH_SIZE) break;
        }
        shards = await readShards(database, options);
      }
      for (const shard of expired) {
        if (storeName === 'runs') break;
        if ((Number(shard.day) + 1) * DAY_MS <= horizon) {
          const records = await deleteRange(database, storeName, 'byStorageTimestamp',
            IDBKeyRange.bound([Number(shard.day) * DAY_MS], [(Number(shard.day) + 1) * DAY_MS], false, true), options);
          deletedRecords += records;
        } else {
          deletedRecords += await deleteRange(database, storeName, 'byStorageTimestamp',
            IDBKeyRange.upperBound([horizon], true), options);
          break;
        }
      }
    }
    options.onMaintenanceProgress?.(index + 1, options.entityStores.length);
  }
  shards = await readShards(database, options);
  const prunedAudits = await curateDirtyAudits(database, shards, options);
  deletedRecords += prunedAudits;
  const readTotals = async () => /** @type {Shard} */ (
    await result(database.transaction(STORAGE_SHARD_STORE).objectStore(STORAGE_SHARD_STORE).get(TOTALS_ID))
      ?? { id: TOTALS_ID, bytes: 0, count: 0 }
  );
  let totals = await readTotals();
  const target = Math.floor(Math.max(0, options.maxDatabaseBytes) * 0.75);
  const usageTarget = Number.isFinite(options.usageBytes) && Number(options.usageBytes) > options.maxDatabaseBytes
    ? Math.floor(totals.bytes * options.maxDatabaseBytes / Number(options.usageBytes) * 0.9) : target;
  const effectiveTarget = Math.min(target, usageTarget);
  while (totals.bytes > effectiveTarget) {
    options.signal?.throwIfAborted();
    const runs = await result(database.transaction('runs').objectStore('runs')
      .index('byStorageTimestamp').getAll(undefined, 1));
    if (runs.length === 0) break;
    deletedRecords += await deleteRun(database, runs[0], options);
    totals = await readTotals();
  }
  options.signal?.throwIfAborted();
  const receipt = database.transaction('transactions', 'readwrite');
  const receiptDone = completed(receipt);
  receipt.objectStore('transactions').put({
    id: AUDIT_CURATION_TRANSACTION_ID, kind: 'audit-curation', version: AUDIT_CURATION_VERSION,
    createdAt: new Date(now).toISOString()
  });
  await receiptDone;
  debug({
    event: 'maintained-storage-shards', durationMs: Math.round(performance.now() - startedAt),
    shardCount: shards.length, deletedRecords, prunedAudits,
    estimatedBytes: totals.bytes, retainedRecords: totals.count
  });
  return { deletedRecords, prunedAudits, estimatedBytes: totals.bytes, retainedRecords: totals.count };
}

/**
 * Explicit repair only. Normal ingestion never reconstructs accounting.
 * @param {IDBDatabase} database
 * @param {readonly string[]} entityStores
 */
export async function rebuildStorageShards(database, entityStores) {
  await write(database, [], async (transaction) => { transaction.objectStore(STORAGE_SHARD_STORE).clear(); });
  for (const storeName of entityStores) {
    /** @type {IDBKeyRange | undefined} */
    let range;
    for (;;) {
      const records = await result(database.transaction(storeName).objectStore(storeName).getAll(range, BATCH_SIZE));
      if (records.length === 0) break;
      await write(database, [storeName], async (transaction) => {
        const store = transaction.objectStore(storeName);
        // Remove before accounting so rebuilding cannot subtract obsolete totals.
        for (const record of records) store.delete(record.id);
        await writeAccountedRecords(transaction, storeName,
          records.map((record) => withStorageMetadata(storeName, record)));
      });
      if (records.length < BATCH_SIZE) break;
      range = IDBKeyRange.lowerBound(records.at(-1)?.id, true);
    }
  }
}
