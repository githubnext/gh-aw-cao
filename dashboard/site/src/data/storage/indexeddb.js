import { relationshipErrors } from '../model/schema.js';

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data';
export const DATABASE_VERSION = 10;

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

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<void>}
 */
export function deleteCanonicalDatabase(indexedDB) {
  const request = indexedDB.deleteDatabase(DATABASE_NAME);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Unable to delete canonical dashboard data'));
    request.onblocked = () => reject(new Error('Deleting canonical dashboard data was blocked'));
  });
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openCanonicalDatabase(indexedDB) {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion < DATABASE_VERSION) {
        // Canonical data is a derived cache. Rebuild incompatible identities and
        // schemas from authoritative dashboard inputs instead of migrating them.
        for (const storeName of [...database.objectStoreNames]) database.deleteObjectStore(storeName);
        createSchema(database);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open canonical dashboard data'));
    request.onblocked = () => reject(new Error('Opening canonical dashboard data was blocked'));
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
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 */
export async function replaceCanonicalBatch(indexedDB, batch) {
  const errors = relationshipErrors(batch);
  if (errors.length > 0) throw new Error(`Canonical relationship validation failed: ${errors.join('; ')}`);
  const database = await openCanonicalDatabase(indexedDB);
  try {
    for (const storeName of ENTITY_STORES) {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const retained = new Set(batch[storeName].map((record) => String(record.id)));
      const existing = await requestResult(store.getAllKeys());
      for (const id of existing) if (!retained.has(String(id))) store.delete(id);
      for (const record of batch[storeName]) store.put(record);
      await transactionDone(transaction);
    }
  } finally {
    database.close();
  }
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

/**
 * Serializes canonical ingestion across tabs and workers.
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {() => Promise<T>} task
 */
export async function withCanonicalIngestionLock(indexedDB, task) {
  const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`;
  for (;;) {
    const database = await openCanonicalDatabase(indexedDB);
    const transaction = database.transaction(TRANSACTION_STORE, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(TRANSACTION_STORE);
    const existing = await requestResult(store.get(INGESTION_LOCK_ID));
    const now = Date.now();
    const acquired = !existing || Number(existing.expiresAt) <= now;
    if (acquired) {
      store.put({
        id: INGESTION_LOCK_ID,
        kind: 'canonical-ingestion-lock',
        createdAt: new Date(now).toISOString(),
        owner,
        expiresAt: now + INGESTION_LOCK_LEASE_MS
      });
    }
    await done;
    database.close();
    if (acquired) break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }

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
