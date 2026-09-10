import { relationshipErrors } from '../model/schema.js';

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data';
export const DATABASE_VERSION = 5;

const ENTITY_STORES = /** @type {const} */ ([
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events',
  'workItems',
  'findings'
]);
const DEFAULT_WRITE_BATCH_SIZE = 1000;

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
  const repositories = database.createObjectStore('repositories', { keyPath: 'id' });
  createIndex(repositories, 'byGithubId', 'githubId');
  createIndex(repositories, 'byFullName', 'fullName');

  const workflows = database.createObjectStore('workflows', { keyPath: 'id' });
  createIndex(workflows, 'byRepository', 'repositoryId');
  createIndex(workflows, 'byRepositoryPath', ['repositoryId', 'path']);

  const runs = database.createObjectStore('runs', { keyPath: 'id' });
  createIndex(runs, 'byRepository', 'repositoryId');
  createIndex(runs, 'byWorkflow', 'workflowId');
  createIndex(runs, 'byStatus', 'status');
  createIndex(runs, 'byRepositoryStartedAt', ['repositoryId', 'startedAt']);
  createIndex(runs, 'byWorkflowStartedAt', ['workflowId', 'startedAt']);

  const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
  createIndex(jobs, 'byRun', 'runId');
  createIndex(jobs, 'byRunStartedAt', ['runId', 'startedAt']);

  const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
  createIndex(sessions, 'byRun', 'runId');
  createIndex(sessions, 'byJob', 'jobId');
  createIndex(sessions, 'byRunStartedAt', ['runId', 'startedAt']);
  createIndex(sessions, 'byJobStartedAt', ['jobId', 'startedAt']);

  const events = database.createObjectStore('events', { keyPath: 'id' });
  createIndex(events, 'bySessionSequence', ['sessionId', 'sequence']);
  createIndex(events, 'bySessionTimestamp', ['sessionId', 'timestamp']);
  createIndex(events, 'byType', 'type');
  createIndex(events, 'bySource', 'source');
  createIndex(events, 'byCorrelation', 'correlationId');

  const workItems = database.createObjectStore('workItems', { keyPath: 'id' });
  createIndex(workItems, 'byLifecycleState', 'lifecycleState');

  const findings = database.createObjectStore('findings', { keyPath: 'id' });
  createIndex(findings, 'bySeverity', 'severity');
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
      if (event.oldVersion < 5) {
        // Canonical data is a derived cache, so the incompatible generation-keyed
        // schema is discarded instead of migrated.
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
