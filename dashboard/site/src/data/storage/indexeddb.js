import { relationshipErrors } from '../model/schema.js';
import { recordTimestamp } from './retention.js';
import { scopedStorageKey } from '../../storage-scope.js';
import { createDebug } from '../../debug.js';
import { tidy } from '../../data-operations.js';

const debug = createDebug('data:indexeddb');

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data';
export const DATABASE_VERSION = 21;

/** @param {string} [pathname] */
export function canonicalDatabaseName(pathname) {
  return scopedStorageKey(DATABASE_NAME, pathname);
}

export const ENTITY_STORES = /** @type {const} */ ([
  'campaigns',
  'repositories',
  'workflows',
  'runs',
  'domains',
  'tools',
  'audits',
  'issues'
]);
export const TRANSACTION_STORE = 'transactions';
export const DATABASE_STORES = /** @type {const} */ ([...ENTITY_STORES, TRANSACTION_STORE]);
/**
 * Derived, disposable daily-aggregate projection stores (spec §72). These
 * are reconstructable from the canonical `runs` collection and are never
 * treated as authoritative data; they exist solely to accelerate eligible
 * additive Overview time-window queries.
 */
export const DAILY_OVERVIEW_AGGREGATE_STORE = 'dailyOverviewAggregates';
export const OVERVIEW_AGGREGATE_METADATA_STORE = 'overviewAggregateMetadata';
export const OVERVIEW_AGGREGATE_METADATA_ID = 'daily-overview-aggregates';
/**
 * Semantic version of the daily overview aggregate projection: field
 * meaning, eligibility rules, UTC day bucketing, and canonical derivation.
 * Any change to those semantics MUST bump this version so readers treat
 * previously published metadata as absent (spec §72.4).
 */
export const DAILY_OVERVIEW_AGGREGATE_VERSION = 2;
export const CANONICAL_DATABASE_SCHEMA = /** @type {Record<
 * string, { keyPath: string, indexes: Record<string, string | string[]> }
 * >} */ ({
 campaigns: {
   keyPath: 'id',
   indexes: { bySlug: 'slug' }
 },
 repositories: {
   keyPath: 'id',
   indexes: {}
 },
 workflows: {
   keyPath: 'id',
   indexes: { byRepository: 'repositoryId' }
 },
 runs: {
   keyPath: 'id',
   indexes: {
     byRepository: 'repositoryId',
     byWorkflow: 'workflowId',
     byConclusion: 'conclusion',
     byEvent: 'event',
     byEventConclusion: ['event', 'conclusion']
   }
 },
 domains: {
   keyPath: 'id',
   indexes: { byRun: 'runId' }
 },
 tools: {
   keyPath: 'id',
   indexes: { byRun: 'runId' }
 },
 audits: {
   keyPath: 'id',
   indexes: { byRun: 'runId' }
  },
  issues: {
    keyPath: 'id',
    indexes: {
      byRun: 'runId'
    }
  },
  transactions: {
    keyPath: 'id',
    indexes: { byCreatedAt: 'createdAt' }
  },
  dailyOverviewAggregates: {
    keyPath: 'id',
    indexes: { byGenerationDay: ['generation', 'day'] }
  },
  overviewAggregateMetadata: {
    keyPath: 'id',
    indexes: {}
  }
});
const DEFAULT_WRITE_BATCH_SIZE = 1000;
const MAX_TRANSACTION_RECORDS = 1000;
const INGESTION_LOCK_ID = 'lock:canonical-ingestion';
const INGESTION_LOCK_LEASE_MS = 5 * 60 * 1000;
const INGESTION_LOCK_ACQUIRE_TIMEOUT_MS = INGESTION_LOCK_LEASE_MS + 30_000;
const INGESTION_LOCK_RETRY_DELAY_MS = 25;
const INGESTION_LOCK_WAITING_NOTICE_DELAY_MS = 500;
const MAX_QUERY_INDEX_LOOKUPS = 32;
const RECORD_OVERHEAD_BYTES = 512;
const RETENTION_TIMESTAMPS = new Set(['runs', 'domains', 'tools', 'audits', 'issues']);
const RUN_LINKED_STORES = /** @type {const} */ (['domains', 'tools', 'audits', 'issues']);
const QUERYABLE_STRING_KEY_PATHS = new Set([
  'slug',
  'repositoryId',
  'workflowId',
  'runId',
  'conclusion',
  'event'
]);
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

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
 * Uses relaxed durability for the reconstructable cache where supported.
 * Safari versions that reject the options argument retain the default path.
 * @param {IDBDatabase} database
 * @param {string | string[]} storeNames
 */
function readwriteTransaction(database, storeNames) {
  try {
    return database.transaction(storeNames, 'readwrite', { durability: 'relaxed' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    debug('relaxed transaction durability unsupported; using default durability', {
      storeCount: Array.isArray(storeNames) ? storeNames.length : 1
    });
    return database.transaction(storeNames, 'readwrite');
  }
}

/** @param {IDBTransaction} transaction */
function commitTransaction(transaction) {
  if (typeof transaction.commit === 'function') {
    debug('explicitly committing queued IndexedDB requests');
    transaction.commit();
  } else {
    debug('explicit IndexedDB commit unsupported; using automatic commit');
  }
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
    let blocked = false;
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        debug('closing database opened after blocked request settled', name);
        database.close();
        return;
      }
      database.onversionchange = () => {
        debug('closing database for version change', name);
        database.close();
      };
      database.onclose = () => debug('database connection closed', name);
      resolve(database);
    };
    request.onerror = () => {
      const error = request.error ?? new Error('Unable to open canonical dashboard data');
      debug('failed to open database', name, error);
      reject(error);
    };
    request.onblocked = () => {
      debug('open database blocked by an older connection', name);
      blocked = true;
      reject(new Error('Opening canonical dashboard data was blocked'));
    };
  });
}

/**
 * Directly upserts a canonical batch using bounded transactions.
 *
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {{ batchSize?: number, validateRelationships?: boolean, signal?: AbortSignal, onBatchCommitted?: (progress: { committedBatches: number, committedRecords: number }) => void | Promise<void> }} [options]
 */
export async function upsertCanonicalBatch(indexedDB, batch, options = {}) {
  options.signal?.throwIfAborted();
  if (options.validateRelationships !== false) {
    const errors = relationshipErrors(batch);
    if (errors.length > 0) {
      throw new Error(`Canonical relationship validation failed: ${errors.join('; ')}`);
    }

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
      options.signal?.throwIfAborted();
      const records = batch[storeName];
      for (let offset = 0; offset < records.length; offset += batchSize) {
        options.signal?.throwIfAborted();
        const boundedRecords = records.slice(offset, offset + batchSize);
        const transaction = readwriteTransaction(database, storeName);
        const done = transactionDone(transaction);
        const store = transaction.objectStore(storeName);
        for (const record of boundedRecords) {
          store.put(record);
        }
        commitTransaction(transaction);
        await done;
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

  /** @param {Record<string, unknown>} record */
function estimatedRecordBytes(record) {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength + RECORD_OVERHEAD_BYTES;
}

/**
 * Applies retention and database-size limits with cursor scans so maintenance
 * never materializes the canonical database or its large linked-record stores.
 *
 * @param {IDBFactory} indexedDB
 * @param {{ now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes: number, usageBytes?: number | null, reconcileRelationships?: boolean, preserveEntityIds?: { repositories?: string[], workflows?: string[] } }} options
 */
export async function maintainCanonicalDatabase(indexedDB, options) {
    const now = options.now ?? Date.now();
    const defaultWindow = Number.isFinite(options.retentionWindowMs)
      ? Math.max(0, Number(options.retentionWindowMs))
      : 30 * 24 * 60 * 60 * 1000;
    const targetBytes = Math.floor(Math.max(0, options.maxDatabaseBytes) * 0.75);
    let estimatedBytes = 0;
    let deletedRecords = 0;
    let retainedRecords = 0;
    /** @type {{ id: string, timestamp: number, bytes: number }[]} */
    const runs = [];
    /** @type {string[]} */
    const expiredRunIds = [];
    /** @type {Map<string, number>} */
    const linkedBytesByRun = new Map();
    /** @type {Map<string, number>} */
    const linkedRecordsByRun = new Map();
    const retainedRunIds = new Set();
    const campaignIds = new Set();
    const repositoryIds = new Set();
    /** @type {Map<string, string>} */
    const workflowRepositories = new Map();
    const validRunIds = new Set();
    const referencedWorkflowIds = new Set();
    const referencedRepositoryIds = new Set();
    const database = await openCanonicalDatabase(indexedDB);
    try {
      for (const storeName of ENTITY_STORES) {
        const transaction = readwriteTransaction(database, storeName);
        const done = transactionDone(transaction);
        const store = transaction.objectStore(storeName);
        /** @param {Record<string, unknown>} record @param {() => void} remove */
        const visit = (record, remove) => {
          const id = String(record.id);
          if (options.reconcileRelationships) {
            if (storeName === 'campaigns') {
              campaignIds.add(id);
            } else if (storeName === 'repositories') {
              repositoryIds.add(id);
            } else if (storeName === 'workflows') {
              const repositoryId = String(record.repositoryId);
              const campaignId = record.campaignId === undefined || record.campaignId === null
                ? null
                : String(record.campaignId);
              if (!repositoryIds.has(repositoryId) || (campaignId !== null && !campaignIds.has(campaignId))) {
                remove();
                deletedRecords += 1;
                return;
              }
              workflowRepositories.set(id, repositoryId);
            } else if (storeName === 'runs') {
              const repositoryId = String(record.repositoryId);
              const workflowId = String(record.workflowId);
              if (!repositoryIds.has(repositoryId) || workflowRepositories.get(workflowId) !== repositoryId) {
                expiredRunIds.push(id);
                return;
              }
              validRunIds.add(id);
              referencedWorkflowIds.add(workflowId);
              referencedRepositoryIds.add(repositoryId);
            } else if (RUN_LINKED_STORES.includes(
              /** @type {typeof RUN_LINKED_STORES[number]} */ (storeName)
            ) && !validRunIds.has(String(record.runId))) {
              remove();
              deletedRecords += 1;
              return;
            }
          }
          const configuredWindow = options.retentionWindowMsByStore?.[storeName];
          const windowMs = Number.isFinite(configuredWindow)
            ? Math.max(0, Number(configuredWindow))
            : defaultWindow;
          const timestamp = recordTimestamp(storeName, record);
          if (RETENTION_TIMESTAMPS.has(storeName)
              && (timestamp === null || timestamp < now - windowMs)) {
            if (storeName === 'runs') {
              expiredRunIds.push(String(record.id));
            } else {
              remove();
              deletedRecords += 1;
            }
            return;
          }
          const bytes = estimatedRecordBytes(record);
          estimatedBytes += bytes;
          retainedRecords += 1;
          if (storeName === 'runs') {
            retainedRunIds.add(id);
            runs.push({
              id: String(record.id),
              timestamp: timestamp ?? Number.NEGATIVE_INFINITY,
              bytes
            });
          } else if (RUN_LINKED_STORES.includes(/** @type {typeof RUN_LINKED_STORES[number]} */ (storeName))) {
            const runId = String(record.runId);
            linkedBytesByRun.set(runId, (linkedBytesByRun.get(runId) ?? 0) + bytes);
            linkedRecordsByRun.set(runId, (linkedRecordsByRun.get(runId) ?? 0) + 1);
          }
        };
        if (typeof store.openCursor !== 'function') {
          for (const record of await requestResult(store.getAll())) {
            visit(record, () => store.delete(record.id));
          }
        } else {
          await new Promise((resolve, reject) => {
            const cursorRequest = store.openCursor();
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) {
                resolve(undefined);
                return;
              }
              visit(cursor.value, () => cursor.delete());
              cursor.continue();
            };
          });
        }
        await done;
      }

      if (options.reconcileRelationships) {
        const preservedWorkflows = new Set(options.preserveEntityIds?.workflows ?? []);
        const survivingWorkflows = new Set([...referencedWorkflowIds, ...preservedWorkflows]);
        for (const workflowId of survivingWorkflows) {
          const repositoryId = workflowRepositories.get(workflowId);
          if (repositoryId) referencedRepositoryIds.add(repositoryId);
        }
        const parentStores = [
          ['workflows', survivingWorkflows],
          ['repositories', new Set([
            ...referencedRepositoryIds,
            ...(options.preserveEntityIds?.repositories ?? [])
          ])]
        ];
        for (const [storeName, retainedIds] of parentStores) {
          const transaction = readwriteTransaction(database, /** @type {string} */ (storeName));
          const done = transactionDone(transaction);
          const store = transaction.objectStore(/** @type {string} */ (storeName));
          /** @param {IDBValidKey} id @param {() => void} remove */
          const removeUnreferenced = (id, remove) => {
            if (/** @type {Set<string>} */ (retainedIds).has(String(id))) return;
            remove();
            deletedRecords += 1;
            retainedRecords -= 1;
          };
          if (typeof store.openCursor !== 'function') {
            for (const record of await requestResult(store.getAll())) {
              removeUnreferenced(record.id, () => store.delete(record.id));
            }
          } else {
            await new Promise((resolve, reject) => {
              const request = store.openCursor();
              request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                  resolve(undefined);
                  return;
                }
                removeUnreferenced(cursor.primaryKey, () => cursor.delete());
                cursor.continue();
              };
            });
          }
          await done;
        }
      }

      for (const runId of expiredRunIds) {
        estimatedBytes -= linkedBytesByRun.get(runId) ?? 0;
        retainedRecords -= linkedRecordsByRun.get(runId) ?? 0;
      }
      const usageTarget = Number.isFinite(options.usageBytes)
        && Number(options.usageBytes) > options.maxDatabaseBytes
        ? Math.floor(estimatedBytes * (options.maxDatabaseBytes / Number(options.usageBytes)) * 0.9)
        : targetBytes;
      const effectiveTarget = Math.min(targetBytes, usageTarget);
      const evictedRunIds = [...expiredRunIds];
      if (estimatedBytes > effectiveTarget) {
        runs.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
        for (const run of runs) {
          if (estimatedBytes <= effectiveTarget) break;
          evictedRunIds.push(run.id);
          estimatedBytes -= run.bytes + (linkedBytesByRun.get(run.id) ?? 0);
          retainedRecords -= 1 + (linkedRecordsByRun.get(run.id) ?? 0);
        }
      }
      for (const runId of expiredRunIds) {
        if (retainedRunIds.has(runId)) retainedRecords -= 1;
      }

      for (let offset = 0; offset < evictedRunIds.length; offset += DEFAULT_WRITE_BATCH_SIZE) {
        const ids = evictedRunIds.slice(offset, offset + DEFAULT_WRITE_BATCH_SIZE);
        const transaction = readwriteTransaction(database, ['runs', ...RUN_LINKED_STORES]);
        const done = transactionDone(transaction);
        const runStore = transaction.objectStore('runs');
        for (const id of ids) {
          runStore.delete(id);
          deletedRecords += 1;
        }
        const idSet = new Set(ids);
        for (const storeName of RUN_LINKED_STORES) {
          const store = transaction.objectStore(storeName);
          const index = store.index('byRun');
          if (typeof index.openCursor !== 'function') {
            const records = await requestResult(store.getAll());
            for (const record of records) {
              if (!idSet.has(String(record.runId))) continue;
              store.delete(record.id);
              deletedRecords += 1;
            }
            continue;
          }
          for (const id of ids) {
            const request = index.openCursor(id);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return;
              cursor.delete();
              deletedRecords += 1;
              cursor.continue();
            };
          }
        }
        await done;
      }

      if (deletedRecords > 0) {
        const transaction = readwriteTransaction(database, [
          DAILY_OVERVIEW_AGGREGATE_STORE,
          OVERVIEW_AGGREGATE_METADATA_STORE
        ]);
        const done = transactionDone(transaction);
        for (const storeName of [DAILY_OVERVIEW_AGGREGATE_STORE, OVERVIEW_AGGREGATE_METADATA_STORE]) {
          const store = transaction.objectStore(storeName);
          if (typeof store.clear === 'function') {
            store.clear();
          } else {
            for (const record of await requestResult(store.getAll())) store.delete(record.id);
          }
        }
        await done;
      }
      return { deletedRecords, estimatedBytes, retainedRecords };
    } finally {
      database.close();
    }
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<import('../model/schema.js').CanonicalBatch>}
 */
export async function readCanonicalBatch(indexedDB) {
  return /** @type {import('../model/schema.js').CanonicalBatch} */ (
    await readCollections(indexedDB, ENTITY_STORES)
  );
}

/**
 * Reads multiple stores through one connection and one readonly transaction.
 * @param {IDBFactory} indexedDB
 * @param {readonly typeof ENTITY_STORES[number][]} storeNames
 */
export async function readCollections(indexedDB, storeNames) {
  const startedAt = monotonicNow();
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const records = storeNames.length === 0
      ? []
      : await (async () => {
        const transaction = database.transaction([...storeNames]);
        const done = transactionDone(transaction);
        const values = await Promise.all(storeNames.map((storeName) =>
          requestResult(transaction.objectStore(storeName).getAll())
        ));
        await done;
        return values;
      })();
    debug('completed multi-store collection read', {
      storeCount: storeNames.length,
      requestCount: storeNames.length,
      stores: [...storeNames].join('|'),
      durationMs: monotonicNow() - startedAt
    });
    return Object.fromEntries(storeNames.map((storeName, index) => [storeName, records[index]]));
  } finally {
    database.close();
  }
}

/**
 * Counts multiple stores through one connection and one readonly transaction.
 * @param {IDBFactory} indexedDB
 * @param {readonly typeof DATABASE_STORES[number][]} storeNames
 */
export async function countCollections(indexedDB, storeNames) {
  const startedAt = monotonicNow();
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const counts = storeNames.length === 0
      ? []
      : await (async () => {
          const transaction = database.transaction([...storeNames]);
          const done = transactionDone(transaction);
          const values = await Promise.all(storeNames.map((storeName) =>
            requestResult(transaction.objectStore(storeName).count())
          ));
          await done;
          return values;
        })();
    debug('completed multi-store collection count', {
      storeCount: storeNames.length,
      requestCount: storeNames.length,
      stores: [...storeNames].join('|'),
      durationMs: monotonicNow() - startedAt
    });
    return Object.fromEntries(storeNames.map((storeName, index) => [storeName, counts[index]]));
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
 * Reads a canonical collection through an opportunistically compiled
 * IndexedDB access plan, then applies the complete operator pipeline in
 * JavaScript to preserve the declarative query semantics.
 *
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {import('../../data-operations.js').DataOperator[]} operators
 * @param {{ onMetrics?: (metrics: { durationMs: number, requestCount: number, recordsScanned: number, recordsReturned: number, index: string | null }) => void }} [options]
 */
export async function queryCollection(indexedDB, storeName, operators, options = {}) {
  const startedAt = monotonicNow();
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(storeName);
    const store = transaction.objectStore(storeName);
    const plan = indexedQueryPlan(store, operators);
    let records;
    if (!plan) {
      records = await requestResult(store.getAll());
    } else {
      const matches = await Promise.all(plan.keys.map((key) => requestResult(plan.index.getAll(key))));
      const keyPath = String(store.keyPath);
      records = [...new Map(matches.flat().map((record) => [record[keyPath], record])).values()]
        .sort((left, right) => indexedDB.cmp(left[keyPath], right[keyPath]));
      debug('compiled collection query', {
        store: storeName,
        index: plan.index.name,
        lookups: plan.keys.length,
        candidateRecords: records.length
      });
    }
    const result = tidy(records, operators);
    const metrics = {
      durationMs: monotonicNow() - startedAt,
      requestCount: plan?.keys.length ?? 1,
      recordsScanned: records.length,
      recordsReturned: result.length,
      index: plan?.index.name ?? null
    };
    debug('completed collection query', { store: storeName, ...metrics });
    options.onMetrics?.(metrics);
    return result;
  } finally {
    database.close();
  }
}

/**
 * @param {IDBObjectStore} store
 * @param {import('../../data-operations.js').DataOperator[]} operators
 */
function indexedQueryPlan(store, operators) {
  const filter = operators[0]?.op === 'filter' ? operators[0] : null;
  if (!filter || filter.search || !filter.predicates?.length) return null;
  const predicates = new Map(/** @type {[string, string[]][]} */ (filter.predicates.flatMap((predicate) => {
    if (predicate.optional || !QUERYABLE_STRING_KEY_PATHS.has(predicate.field)) return [];
    const values = Array.isArray(predicate.in) ? predicate.in : [predicate.equals];
    return values.length > 0
      && values.every((value) => typeof value === 'string' && value !== 'unknown')
      ? [[predicate.field, /** @type {string[]} */ (values)]]
      : [];
  })));
  /** @type {{ index: IDBIndex, keys: IDBValidKey[] } | null} */
  let best = null;
  for (const indexName of store.indexNames) {
    const index = store.index(indexName);
    const keyPath = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath];
    if (!keyPath.every((field) => typeof field === 'string' && predicates.has(field))) continue;
    const keys = keyPath.reduce(
      (combinations, field) => combinations.flatMap((combination) =>
        (predicates.get(String(field)) ?? []).map((value) => [...combination, value])
      ),
      /** @type {string[][]} */ ([[]])
    ).map((key) => keyPath.length === 1 ? key[0] : key);
    if (keys.length > MAX_QUERY_INDEX_LOOKUPS) continue;
    if (!best || keyPath.length > (Array.isArray(best.index.keyPath) ? best.index.keyPath.length : 1)) {
      best = { index, keys };
    }
  }
  return best;
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
 * @param {{ batchSize?: number, onProgress?: (progress: { storedRecords: number, totalRecords: number }) => void, onMetrics?: (metrics: { durationMs: number, requestCount: number, storedRecords: number, deletedRecords: number, scannedKeys: number, committedBatches: number, abortedTransactions: number }) => void, previousBatch?: import('../model/schema.js').CanonicalBatch, signal?: AbortSignal }} [options]
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
  const previousBatch = options.previousBatch;
  const recordsToDelete = previousBatch
    ? Object.fromEntries(ENTITY_STORES.map((storeName) => {
        const retained = new Set(batch[storeName].map((record) => String(record.id)));
        return [storeName, previousBatch[storeName]
          .map((record) => record.id)
          .filter((id) => !retained.has(String(id)))];
      }))
    : null;
  const totalRecords = ENTITY_STORES.reduce(
    (total, storeName) => total + recordsToWrite[storeName].length,
    0
  );
  let storedRecords = 0;
  let deletedRecords = 0;
  let scannedKeys = 0;
  let requestCount = 0;
  let committedBatches = 0;
  let abortedTransactions = 0;
  const startedAt = monotonicNow();
  const currentMetrics = () => ({
    durationMs: monotonicNow() - startedAt,
    requestCount,
    storedRecords,
    deletedRecords,
    scannedKeys,
    committedBatches,
    abortedTransactions
  });
  debug('starting canonical batch replacement', { totalRecords, batchSize });
  const database = await openCanonicalDatabase(indexedDB);
  try {
    for (const storeName of ENTITY_STORES) {
      const records = batch[storeName];
      const retained = new Set(records.map((record) => String(record.id)));
      // Evict first so reclaimed space is available to the writes that follow.
      const removal = readwriteTransaction(database, storeName);
      const removalDone = transactionDone(removal);
      const removalStore = removal.objectStore(storeName);
      const knownDeleted = recordsToDelete?.[storeName];
      const reconciliationStrategy = knownDeleted
        ? 'retained-snapshot'
        : typeof removalStore.openKeyCursor === 'function'
          ? 'key-cursor'
          : 'all-keys-fallback';
      try {
        if (knownDeleted) {
          for (const id of knownDeleted) removalStore.delete(/** @type {IDBValidKey} */ (id));
          deletedRecords += knownDeleted.length;
          requestCount += knownDeleted.length;
          commitTransaction(removal);
        } else if (typeof removalStore.openKeyCursor !== 'function') {
          requestCount += 1;
          const existing = await requestResult(removalStore.getAllKeys());
          scannedKeys += existing.length;
          for (const id of existing) {
            if (retained.has(String(id))) continue;
            removalStore.delete(id);
            deletedRecords += 1;
            requestCount += 1;
          }
        } else {
          await new Promise((resolve, reject) => {
            requestCount += 1;
            const cursorRequest = removalStore.openKeyCursor();
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB key cursor failed'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) {
                resolve(undefined);
                return;
              }
              scannedKeys += 1;
              if (!retained.has(String(cursor.primaryKey))) {
                removalStore.delete(cursor.primaryKey);
                deletedRecords += 1;
                requestCount += 1;
              }
              cursor.continue();
            };
          });
        }
        await removalDone;
        committedBatches += 1;
      } catch (error) {
        abortedTransactions += 1;
        try {
          removal.abort();
        } catch {
          // The transaction already aborted or completed.
        }
        await removalDone.catch(() => undefined);
        throw error;
      }
      debug('completed canonical store eviction', {
        store: storeName,
        retainedRecords: retained.size,
        deletedRecords: knownDeleted?.length ?? deletedRecords,
        scannedKeys: knownDeleted ? 0 : scannedKeys,
        reconciliationStrategy
      });
      const changedRecords = recordsToWrite[storeName];
      for (let offset = 0; offset < changedRecords.length; offset += batchSize) {
        const boundedRecords = changedRecords.slice(offset, offset + batchSize);
        const transaction = readwriteTransaction(database, storeName);
        const done = transactionDone(transaction);
        const store = transaction.objectStore(storeName);
        try {
          for (const record of boundedRecords) store.put(record);
          requestCount += boundedRecords.length;
          commitTransaction(transaction);
          await done;
          committedBatches += 1;
        } catch (error) {
          abortedTransactions += 1;
          try {
            transaction.abort();
          } catch {
            // The transaction already aborted or completed.
          }
          await done.catch(() => undefined);
          throw error;
        }
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
  } catch (error) {
    const metrics = currentMetrics();
    debug('canonical batch replacement failed', metrics);
    options.onMetrics?.(metrics);
    throw error;
  } finally {
    database.close();
  }
  const metrics = currentMetrics();
  debug('completed canonical batch replacement', metrics);
  options.onMetrics?.(metrics);
}

/** @param {string} generation @param {string} day */
function dailyOverviewAggregateId(generation, day) {
  return `${generation}:${day}`;
}

/**
 * Publishes a complete daily overview aggregate generation (spec §72.5).
 *
 * Crash-safe by construction: every record for the new `generation` is
 * written under its own id (`generation:day`) without touching any existing
 * generation's records. Only after every record has committed does a final,
 * separate transaction atomically republish the metadata record so that
 * `activeGeneration` starts pointing at the new generation. A crash at any
 * point before that final transaction leaves the previously active
 * generation (if any) completely untouched and readable; an interrupted
 * generation is never referenced by metadata and can be garbage-collected by
 * a later call to {@link pruneStaleDailyOverviewAggregates}.
 *
 * @param {IDBFactory} indexedDB
 * @param {{
 *   generation: string,
 *   builtAt?: string,
 *   dailyAggregates: import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[],
 *   batchSize?: number
 * }} options
 * @returns {Promise<{ id: string, version: number, activeGeneration: string, builtAt: string, firstDay: string | null, lastDay: string | null }>}
 */
export async function publishDailyOverviewAggregates(indexedDB, options) {
  const { generation, dailyAggregates } = options;
  if (typeof generation !== 'string' || !generation) {
    throw new TypeError('generation is required to publish daily overview aggregates');
  }
  const builtAt = options.builtAt ?? new Date().toISOString();
  const batchSize = options.batchSize ?? DEFAULT_WRITE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('Write batch size must be a positive integer');
  }
  const records = dailyAggregates.map((record) => ({
    ...record,
    id: dailyOverviewAggregateId(generation, record.day),
    generation
  }));
  const database = await openCanonicalDatabase(indexedDB);
  try {
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const chunk = records.slice(offset, offset + batchSize);
      const transaction = readwriteTransaction(database, DAILY_OVERVIEW_AGGREGATE_STORE);
      const done = transactionDone(transaction);
      const store = transaction.objectStore(DAILY_OVERVIEW_AGGREGATE_STORE);
      for (const record of chunk) store.put(record);
      commitTransaction(transaction);
      await done;
    }
    const days = [...dailyAggregates.map((record) => record.day)].sort();
    const metadata = {
      id: OVERVIEW_AGGREGATE_METADATA_ID,
      version: DAILY_OVERVIEW_AGGREGATE_VERSION,
      activeGeneration: generation,
      builtAt,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null
    };
    // Atomic activation: this is the only write that changes which
    // generation readers observe as active.
    const publish = readwriteTransaction(database, OVERVIEW_AGGREGATE_METADATA_STORE);
    const publishDone = transactionDone(publish);
    publish.objectStore(OVERVIEW_AGGREGATE_METADATA_STORE).put(metadata);
    commitTransaction(publish);
    await publishDone;
    debug('published daily overview aggregate generation', {
      generation,
      records: records.length,
      firstDay: metadata.firstDay,
      lastDay: metadata.lastDay
    });
    return metadata;
  } finally {
    database.close();
  }
}

/**
 * Deletes daily overview aggregate records left behind by any generation
 * other than the currently active one (superseded rebuilds, or a rebuild
 * that was interrupted before publication). Never touches the active
 * generation's records.
 *
 * @param {IDBFactory} indexedDB
 * @returns {Promise<{ deletedRecords: number }>}
 */
export async function pruneStaleDailyOverviewAggregates(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const metadata = await requestResult(
      database.transaction(OVERVIEW_AGGREGATE_METADATA_STORE)
        .objectStore(OVERVIEW_AGGREGATE_METADATA_STORE)
        .get(OVERVIEW_AGGREGATE_METADATA_ID)
    );
    const activeGeneration = metadata && typeof metadata === 'object' ? metadata.activeGeneration : undefined;
    const transaction = readwriteTransaction(database, DAILY_OVERVIEW_AGGREGATE_STORE);
    const done = transactionDone(transaction);
    const store = transaction.objectStore(DAILY_OVERVIEW_AGGREGATE_STORE);
    const all = await requestResult(store.getAll());
    let deletedRecords = 0;
    for (const record of all) {
      if (record.generation !== activeGeneration) {
        store.delete(record.id);
        deletedRecords += 1;
      }
    }
    commitTransaction(transaction);
    await done;
    debug('pruned stale daily overview aggregate generations', { activeGeneration, deletedRecords });
    return { deletedRecords };
  } finally {
    database.close();
  }
}

/**
 * Reads the daily overview aggregate metadata record without range-reading
 * any day records. Callers that need the full available day range (e.g. a
 * query-planner fast path summing over "all retained history") use this to
 * discover `firstDay`/`lastDay` before issuing a bounded range read, instead
 * of guessing a range. Fails closed exactly like {@link readDailyOverviewAggregates}.
 *
 * @param {IDBFactory} indexedDB
 * @returns {Promise<{
 *   available: boolean,
 *   fallbackReason: string | null,
 *   generation: string | null,
 *   version: number | null,
 *   firstDay: string | null,
 *   lastDay: string | null
 * }>}
 */
export async function readOverviewAggregateMetadata(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const metadata = await requestResult(
      database.transaction(OVERVIEW_AGGREGATE_METADATA_STORE)
        .objectStore(OVERVIEW_AGGREGATE_METADATA_STORE)
        .get(OVERVIEW_AGGREGATE_METADATA_ID)
    );
    const activeGeneration = metadata && typeof metadata === 'object' ? metadata.activeGeneration : null;
    const version = metadata && typeof metadata === 'object' ? metadata.version ?? null : null;
    if (!metadata || typeof activeGeneration !== 'string' || !activeGeneration) {
      return {
        available: false,
        fallbackReason: 'metadata-missing',
        generation: null,
        version,
        firstDay: null,
        lastDay: null
      };
    }
    if (version !== DAILY_OVERVIEW_AGGREGATE_VERSION) {
      return {
        available: false,
        fallbackReason: 'version-mismatch',
        generation: activeGeneration,
        version,
        firstDay: null,
        lastDay: null
      };
    }
    return {
      available: true,
      fallbackReason: null,
      generation: activeGeneration,
      version,
      firstDay: typeof metadata.firstDay === 'string' ? metadata.firstDay : null,
      lastDay: typeof metadata.lastDay === 'string' ? metadata.lastDay : null
    };
  } finally {
    database.close();
  }
}

/**
 * Range-reads daily overview aggregate records for the currently active
 * generation (spec §72.8). Fails closed: returns `available: false` with a
 * `fallbackReason` whenever the metadata record is absent or its version
 * does not match the version this build understands, so callers always have
 * a safe canonical query fallback instead of trusting an incompatible or
 * partially materialized projection.
 *
 * @param {IDBFactory} indexedDB
 * @param {{ startDay: string, endDay: string }} range
 * @returns {Promise<{
 *   available: boolean,
 *   fallbackReason: string | null,
 *   generation: string | null,
 *   version: number | null,
 *   records: import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[],
 *   recordsScanned: number,
 *   recordsReturned: number,
 *   requestCount: number,
 *   durationMs: number
 * }>}
 */
export async function readDailyOverviewAggregates(indexedDB, range) {
  const startedAt = monotonicNow();
  let requestCount = 0;
  const database = await openCanonicalDatabase(indexedDB);
  try {
    requestCount += 1;
    const metadata = await requestResult(
      database.transaction(OVERVIEW_AGGREGATE_METADATA_STORE)
        .objectStore(OVERVIEW_AGGREGATE_METADATA_STORE)
        .get(OVERVIEW_AGGREGATE_METADATA_ID)
    );
    const activeGeneration = metadata && typeof metadata === 'object' ? metadata.activeGeneration : null;
    const version = metadata && typeof metadata === 'object' ? metadata.version ?? null : null;
    if (!metadata || typeof activeGeneration !== 'string' || !activeGeneration) {
      const result = {
        available: false,
        fallbackReason: 'metadata-missing',
        generation: null,
        version,
        records: [],
        recordsScanned: 0,
        recordsReturned: 0,
        requestCount,
        durationMs: monotonicNow() - startedAt
      };
      debug('daily overview aggregate metadata unavailable; falling back', result);
      return result;
    }
    if (version !== DAILY_OVERVIEW_AGGREGATE_VERSION) {
      const result = {
        available: false,
        fallbackReason: 'version-mismatch',
        generation: activeGeneration,
        version,
        records: [],
        recordsScanned: 0,
        recordsReturned: 0,
        requestCount,
        durationMs: monotonicNow() - startedAt
      };
      debug('daily overview aggregate version mismatch; falling back', result);
      return result;
    }
    requestCount += 1;
    const store = database.transaction(DAILY_OVERVIEW_AGGREGATE_STORE)
      .objectStore(DAILY_OVERVIEW_AGGREGATE_STORE);
    const index = store.index('byGenerationDay');
    const records = await requestResult(index.getAll(
      IDBKeyRange.bound([activeGeneration, range.startDay], [activeGeneration, range.endDay])
    ));
    const result = {
      available: true,
      fallbackReason: null,
      generation: activeGeneration,
      version,
      records,
      recordsScanned: records.length,
      recordsReturned: records.length,
      requestCount,
      durationMs: monotonicNow() - startedAt
    };
    debug('completed daily overview aggregate read', {
      generation: activeGeneration,
      recordsReturned: records.length,
      requestCount,
      durationMs: result.durationMs
    });
    return result;
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
    const write = readwriteTransaction(database, TRANSACTION_STORE);
    const done = transactionDone(write);
    const store = write.objectStore(TRANSACTION_STORE);
    store.put(transaction);
    /** @param {Record<string, unknown> | undefined} candidate */
    const persistentReceipt = (candidate) => candidate?.kind === 'ingest-normalized-json'
      && typeof candidate.payloadHash === 'string';
    if (typeof store.count !== 'function' || typeof store.index('byCreatedAt').openCursor !== 'function') {
      const records = await requestResult(store.index('byCreatedAt').getAll());
      let remaining = Math.max(0, records.length - MAX_TRANSACTION_RECORDS);
      for (const expired of records) {
        if (remaining === 0) break;
        if (persistentReceipt(expired)) continue;
        store.delete(expired.id);
        remaining -= 1;
      }
    } else {
      const count = await requestResult(store.count());
      let remaining = Math.max(0, count - MAX_TRANSACTION_RECORDS);
      await new Promise((resolve, reject) => {
        const cursorRequest = store.index('byCreatedAt').openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB transaction cursor failed'));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || remaining === 0) {
            resolve(undefined);
            return;
          }
          if (!persistentReceipt(cursor.value)) {
            cursor.delete();
            remaining -= 1;
          }
          cursor.continue();
        };
      });
    }
    await done;
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
