import { relationshipErrors } from '../model/schema.js';
import { scopedStorageKey } from '../../storage-scope.js';
import { createDebug } from '../../debug.js';

const debug = createDebug('data:indexeddb');

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data';
export const DATABASE_VERSION = 12;

/** @param {string} [pathname] */
export function canonicalDatabaseName(pathname) {
  return scopedStorageKey(DATABASE_NAME, pathname);
}

export const ENTITY_STORES = /** @type {const} */ ([
  'packages',
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events'
]);
export const TRANSACTION_STORE = 'transactions';
export const CANONICAL_DATABASE_SCHEMA = /** @type {Record<
 * string, { keyPath: string, indexes: Record<string, string | string[]> }
 * >} */ ({
 packages: {
   keyPath: 'id',
   indexes: { bySlug: 'slug' }
 },
 repositories: {
    keyPath: 'id',
    indexes: { byGithubId: 'githubId', byFullName: 'fullName' }
  },
  workflows: {
    keyPath: 'id',
    indexes: { byRepository: 'repositoryId', byRepositoryPath: ['repositoryId', 'path'] }
  },
  runs: {
    keyPath: 'id',
    indexes: {
      byRepository: 'repositoryId',
      byWorkflow: 'workflowId',
      byStatus: 'status',
      byRepositoryStartedAt: ['repositoryId', 'startedAt'],
      byWorkflowStartedAt: ['workflowId', 'startedAt']
    }
  },
  jobs: {
    keyPath: 'id',
    indexes: { byRun: 'runId', byRunStartedAt: ['runId', 'startedAt'] }
  },
  sessions: {
    keyPath: 'id',
    indexes: {
      byRun: 'runId',
      byJob: 'jobId',
      byRunStartedAt: ['runId', 'startedAt'],
      byJobStartedAt: ['jobId', 'startedAt']
    }
  },
  events: {
    keyPath: 'id',
    indexes: {
      bySessionSequence: ['sessionId', 'sequence'],
      bySessionTimestamp: ['sessionId', 'timestamp'],
      byType: 'type',
      bySource: 'source',
      byCorrelation: 'correlationId'
    }
  },
  transactions: {
    keyPath: 'id',
    indexes: { byCreatedAt: 'createdAt', byKind: 'kind' }
  }
});
const DEFAULT_WRITE_BATCH_SIZE = 1000;
const MAX_TRANSACTION_RECORDS = 1000;
const INGESTION_LOCK_ID = 'lock:canonical-ingestion';
const INGESTION_LOCK_LEASE_MS = 5 * 60 * 1000;
const INGESTION_LOCK_ACQUIRE_TIMEOUT_MS = INGESTION_LOCK_LEASE_MS + 30_000;
const INGESTION_LOCK_RETRY_DELAY_MS = 25;
const INGESTION_LOCK_WAITING_NOTICE_DELAY_MS = 500;

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * @param {unknown} existing
 * @param {number} now
 */
function ingestionLockLease(existing, now) {
  if (!existing || typeof existing !== 'object') return { active: false, expiresAt: null };
  const expiresAt = Number(/** @type {{ expiresAt?: unknown }} */ (existing).expiresAt);
  return {
    active: Number.isFinite(expiresAt)
      && expiresAt > now
      && expiresAt <= now + INGESTION_LOCK_LEASE_MS,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
  };
}

/**
 * @param {IDBObjectStore} store
 * @param {string} name
 * @param {string | string[]} keyPath
 */
function createIndex(store, name, keyPath) {
  store.createIndex(name, keyPath);
}

/** @param {IDBDatabase} database */
function createSchema(database) {
  for (const [storeName, definition] of Object.entries(CANONICAL_DATABASE_SCHEMA)) {
    const store = database.createObjectStore(storeName, { keyPath: definition.keyPath });
    for (const [indexName, keyPath] of Object.entries(definition.indexes)) {
      createIndex(store, indexName, keyPath);
    }
  }
}

const DELETE_BLOCKED_TIMEOUT_MS = 3_000;

/**
 * @param {IDBFactory} indexedDB
 * @param {{ blockedTimeoutMs?: number, onBlocked?: () => void }} [options]
 * @returns {Promise<void>}
 */
export function deleteCanonicalDatabase(indexedDB, options = {}) {
  const name = canonicalDatabaseName();
  const blockedTimeoutMs = options.blockedTimeoutMs ?? DELETE_BLOCKED_TIMEOUT_MS;
  debug('deleting database', name);
  const request = indexedDB.deleteDatabase(name);
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let blockedTimeout;
    const settle = (/** @type {() => void} */ action) => {
      if (blockedTimeout !== undefined) clearTimeout(blockedTimeout);
      action();
    };
    request.onsuccess = () => settle(() => {
      debug('deleted database', name);
      resolve();
    });
    request.onerror = () => settle(() => {
      const error = request.error ?? new Error('Unable to delete canonical dashboard data');
      debug('failed to delete database', name, error);
      reject(error);
    });
    request.onblocked = () => {
      // Another open connection (a stale tab, worker, or leaked handle) is
      // still holding the database open. The delete request stays pending
      // and resolves once that connection closes, so give it a bounded grace
      // period instead of hanging indefinitely or failing immediately.
      debug('delete database blocked by an open connection', name);
      options.onBlocked?.();
      if (blockedTimeout === undefined) {
        blockedTimeout = setTimeout(() => {
          debug('delete database still blocked after timeout', name);
          const error = new Error('Deleting canonical dashboard data was blocked by another open tab or connection');
          error.name = 'IndexedDBDeleteBlockedError';
          reject(error);
        }, blockedTimeoutMs);
      }
    };
  });
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openCanonicalDatabase(indexedDB) {
  const name = canonicalDatabaseName();
  const request = indexedDB.open(name, DATABASE_VERSION);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion < DATABASE_VERSION) {
        // Canonical data is a derived cache. Rebuild incompatible identities and
        // schemas from authoritative dashboard inputs instead of migrating them.
        debug('upgrading database schema', name, { from: event.oldVersion, to: DATABASE_VERSION });
        for (const storeName of [...database.objectStoreNames]) database.deleteObjectStore(storeName);
        createSchema(database);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error ?? new Error('Unable to open canonical dashboard data');
      debug('failed to open database', name, error);
      reject(error);
    };
    request.onblocked = () => {
      debug('open database blocked by an older connection', name);
      reject(new Error('Opening canonical dashboard data was blocked'));
    };
  });
}

/**
 * Directly upserts a canonical batch using bounded transactions.
 *
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {{ batchSize?: number, onBatchCommitted?: (progress: { committedBatches: number, committedRecords: number }) => void | Promise<void> }} [options]
 */
export async function upsertCanonicalBatch(indexedDB, batch, options = {}) {
  const errors = relationshipErrors(batch);
  if (errors.length > 0) {
    throw new Error(`Canonical relationship validation failed: ${errors.join('; ')}`);
  }

  const batchSize = options.batchSize ?? DEFAULT_WRITE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('Write batch size must be a positive integer');
  }

  const database = await openCanonicalDatabase(indexedDB);
  try {
    let committedRecords = 0;
    let committedBatches = 0;
    for (const storeName of ENTITY_STORES) {
      const records = batch[storeName];
      for (let offset = 0; offset < records.length; offset += batchSize) {
        const boundedRecords = records.slice(offset, offset + batchSize);
        const transaction = database.transaction(storeName, 'readwrite');
        for (const record of boundedRecords) {
          transaction.objectStore(storeName).put(record);
        }
        await transactionDone(transaction);
        committedRecords += boundedRecords.length;
        committedBatches += 1;
        await options.onBatchCommitted?.({ committedBatches, committedRecords });
      }
    }
    return { committedBatches, committedRecords };
  } finally {
    database.close();
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<import('../model/schema.js').CanonicalBatch>}
 */
export async function readCanonicalBatch(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(ENTITY_STORES);
    const records = await Promise.all(ENTITY_STORES.map((storeName) =>
      requestResult(transaction.objectStore(storeName).getAll())
    ));
    return /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(
      ENTITY_STORES.map((storeName, index) => [storeName, records[index]])
    ));
  } finally {
    database.close();
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 */
export async function readCollection(indexedDB, storeName) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    return await requestResult(database.transaction(storeName).objectStore(storeName).getAll());
  } finally {
    database.close();
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} id
 */
export async function readRecord(indexedDB, storeName, id) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const result = await requestResult(database.transaction(storeName).objectStore(storeName).get(id));
    return result && typeof result === 'object' ? result : null;
  } finally {
    database.close();
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} indexName
 * @param {(string | number)[]} key
 */
export async function readIndex(indexedDB, storeName, indexName, key) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const index = database.transaction(storeName).objectStore(storeName).index(indexName);
    if (key.length === 1 && !Array.isArray(index.keyPath)) {
      return await requestResult(index.getAll(key[0]));
    }
    return await requestResult(index.getAll(
      IDBKeyRange.bound(key, [...key, []], false, true)
    ));
  } finally {
    database.close();
  }
}

/**
 * Replaces retained canonical records with the supplied batch.
 *
 * Records are written in bounded transactions so a constrained browser reports
 * quota pressure after one chunk instead of after a whole store, and so callers
 * can report progress while very large batches are stored.
 *
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {{ batchSize?: number, onProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, previousBatch?: import('../model/schema.js').CanonicalBatch, signal?: AbortSignal }} [options]
 */
export async function replaceCanonicalBatch(indexedDB, batch, options = {}) {
  options.signal?.throwIfAborted();
  const errors = relationshipErrors(batch);
  if (errors.length > 0) throw new Error(`Canonical relationship validation failed: ${errors.join('; ')}`);
  const batchSize = options.batchSize ?? DEFAULT_WRITE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('Write batch size must be a positive integer');
  }
  const recordsToWrite = Object.fromEntries(ENTITY_STORES.map((storeName) => {
    const previous = new Map((options.previousBatch?.[storeName] ?? [])
      .map((record) => [String(record.id), record]));
    return [storeName, batch[storeName].filter((record) => {
      const retained = previous.get(String(record.id));
      return retained !== record
        && (!retained || JSON.stringify(retained) !== JSON.stringify(record));
    })];
  }));
  const totalRecords = ENTITY_STORES.reduce(
    (total, storeName) => total + recordsToWrite[storeName].length,
    0
  );
  let storedRecords = 0;
  debug('starting canonical batch replacement', { totalRecords, batchSize });
  const database = await openCanonicalDatabase(indexedDB);
  try {
    for (const storeName of ENTITY_STORES) {
      const records = batch[storeName];
      const retained = new Set(records.map((record) => String(record.id)));
      // Evict first so reclaimed space is available to the writes that follow.
      const removal = database.transaction(storeName, 'readwrite');
      const removalStore = removal.objectStore(storeName);
      const existing = await requestResult(removalStore.getAllKeys());
      for (const id of existing) if (!retained.has(String(id))) removalStore.delete(id);
      await transactionDone(removal);
      debug('completed canonical store eviction', {
        store: storeName,
        retainedRecords: retained.size,
        existingRecords: existing.length
      });
      const changedRecords = recordsToWrite[storeName];
      for (let offset = 0; offset < changedRecords.length; offset += batchSize) {
        const boundedRecords = changedRecords.slice(offset, offset + batchSize);
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        for (const record of boundedRecords) store.put(record);
        await transactionDone(transaction);
        storedRecords += boundedRecords.length;
        debug('committed canonical write chunk', {
          store: storeName,
          chunkRecords: boundedRecords.length,
          storedRecords,
          totalRecords
        });
        options.onProgress?.({ storedRecords, totalRecords });
      }
    }
    // Empty batches still report a terminal progress update.
    if (totalRecords === 0) options.onProgress?.({ storedRecords, totalRecords });
  } finally {
    database.close();
  }
  debug('completed canonical batch replacement', { storedRecords, totalRecords });
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ id: string, kind: string, createdAt: string, [field: string]: unknown }} transaction
 */
export async function recordTransaction(indexedDB, transaction) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const write = database.transaction(TRANSACTION_STORE, 'readwrite');
    const store = write.objectStore(TRANSACTION_STORE);
    store.put(transaction);
    const records = await requestResult(store.index('byCreatedAt').getAll());
    for (const expired of records
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .slice(0, Math.max(0, records.length - MAX_TRANSACTION_RECORDS))) {
      store.delete(expired.id);
    }
    await transactionDone(write);
    debug('recorded ingestion transaction', {
      kind: transaction.kind,
      committedRecords: transaction.committedRecords ?? null
    });
  } finally {
    database.close();
  }
}

/** @param {IDBFactory} indexedDB @param {string} id */
export async function readTransaction(indexedDB, id) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const result = await requestResult(
      database.transaction(TRANSACTION_STORE).objectStore(TRANSACTION_STORE).get(id)
    );
    return result && typeof result === 'object' ? result : null;
  } finally {
    database.close();
  }
}

/** @returns {Error} */
function ingestionLockTimeoutError() {
  const error = new Error('Timed out waiting for canonical ingestion lock');
  error.name = 'CanonicalIngestionLockTimeoutError';
  return error;
}

/**
 * Serializes canonical ingestion with the Web Locks API, which the browser
 * releases as soon as the holding tab or worker goes away. A leased record
 * cannot do that: a tab terminated mid-ingestion leaves its lease behind, and
 * every later ingestion then stalls until that lease expires.
 *
 * @template T
 * @param {LockManager} locks
 * @param {() => Promise<T>} task
 * @param {{ acquireTimeoutMs?: number, waitingNoticeDelayMs?: number, onWaiting?: () => void }} options
 */
async function withWebIngestionLock(locks, task, options) {
  const name = `canonical-ingestion:${canonicalDatabaseName()}`;
  const startedAt = Date.now();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? INGESTION_LOCK_ACQUIRE_TIMEOUT_MS;
  const controller = new AbortController();
  let acquired = false;
  // Aborting only cancels a request that is still pending, so a granted lock
  // keeps the ingestion running for as long as it needs.
  const timeout = setTimeout(() => controller.abort(), acquireTimeoutMs);
  const notice = setTimeout(() => {
    if (!acquired) options.onWaiting?.();
  }, options.waitingNoticeDelayMs ?? INGESTION_LOCK_WAITING_NOTICE_DELAY_MS);
  try {
    return await locks.request(name, { mode: 'exclusive', signal: controller.signal }, async () => {
      acquired = true;
      clearTimeout(timeout);
      clearTimeout(notice);
      debug('acquired canonical ingestion lock', { name, waitedMs: Date.now() - startedAt });
      try {
        return await task();
      } finally {
        debug('released canonical ingestion lock', { name });
      }
    });
  } catch (error) {
    if (!acquired
        && controller.signal.aborted
        && /** @type {{ name?: unknown }} */ (error)?.name === 'AbortError') {
      debug('timed out waiting for canonical ingestion lock', { name, waitedMs: Date.now() - startedAt });
      throw ingestionLockTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(notice);
  }
}

/**
 * Serializes canonical ingestion across tabs and workers.
 *
 * `locks` selects how ingestion is serialized: omitting it uses the Web Locks
 * API when the environment provides it, and passing `null` forces the leased
 * lock record kept in the transactions store.
 *
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {() => Promise<T>} task
 * @param {{ acquireTimeoutMs?: number, retryDelayMs?: number, waitingNoticeDelayMs?: number, onWaiting?: () => void, locks?: LockManager | null }} [options]
 */
export async function withCanonicalIngestionLock(indexedDB, task, options = {}) {
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
  if (locks && typeof locks.request === 'function') {
    return await withWebIngestionLock(locks, task, options);
  }
  const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
  const startedAt = Date.now();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? INGESTION_LOCK_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? INGESTION_LOCK_RETRY_DELAY_MS;
  const waitingNoticeDelayMs = options.waitingNoticeDelayMs ?? INGESTION_LOCK_WAITING_NOTICE_DELAY_MS;
  let notified = false;
  for (;;) {
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > acquireTimeoutMs) throw ingestionLockTimeoutError();
    const database = await openCanonicalDatabase(indexedDB);
    let acquired;
    try {
      const transaction = database.transaction(TRANSACTION_STORE, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(TRANSACTION_STORE);
      const existing = await requestResult(store.get(INGESTION_LOCK_ID));
      const now = Date.now();
      const lease = ingestionLockLease(existing, now);
      acquired = !lease.active;
      if (acquired) {
        if (existing) {
          debug('replacing stale canonical ingestion lock', {
            heldBy: existing?.owner ?? null,
            expiresAt: lease.expiresAt,
            waitedMs: now - startedAt
          });
        }
        store.put({
          id: INGESTION_LOCK_ID,
          kind: 'canonical-ingestion-lock',
          createdAt: new Date(now).toISOString(),
          owner,
          expiresAt: now + INGESTION_LOCK_LEASE_MS
        });
      } else {
        debug('waiting for canonical ingestion lock', {
          heldBy: existing?.owner ?? null,
          expiresInMs: Number(existing?.expiresAt ?? 0) - now,
          waitedMs: now - startedAt
        });
        if (!notified && now - startedAt >= waitingNoticeDelayMs) {
          notified = true;
          options.onWaiting?.();
        }
      }
      await done;
    } finally {
      // Always close the connection, even if the lock check fails, so a
      // failed acquisition attempt never leaves an open handle that blocks
      // subsequent opens, writes, or a local-data reset.
      database.close();
    }
    if (acquired) break;
    await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
  }
  debug('acquired canonical ingestion lock', { owner, waitedMs: Date.now() - startedAt });

  try {
    return await task();
  } finally {
    const database = await openCanonicalDatabase(indexedDB);
    try {
      const transaction = database.transaction(TRANSACTION_STORE, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(TRANSACTION_STORE);
      const existing = await requestResult(store.get(INGESTION_LOCK_ID));
      if (existing?.owner === owner) store.delete(INGESTION_LOCK_ID);
      await done;
    } finally {
      database.close();
    }
    debug('released canonical ingestion lock', { owner });
  }
}

/** @param {IDBFactory} indexedDB */
export async function readTransactions(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    return await requestResult(database.transaction(TRANSACTION_STORE).objectStore(TRANSACTION_STORE).getAll());
  } finally {
    database.close();
  }
}
