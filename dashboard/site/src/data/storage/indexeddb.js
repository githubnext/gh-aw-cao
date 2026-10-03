import { EVIDENCE_DEFINITION_STORES, mergeEvidenceDefinition, relationshipErrors } from '../model/schema.js';
import { pruneCanonicalRecord } from '../model/fields.js';
import { recordTimestamp } from './retention.js';
import { scopedStorageKey } from '../../storage-scope.js';
import { createDebug } from '../../debug.js';
import { tidy } from '../../data-operations.js';
import {
  AUDIT_CURATION_TRANSACTION_ID,
  AUDIT_CURATION_VERSION,
  auditCurationRunFacts,
  discardAudit
} from '../model/audit-curation.js';

const debug = createDebug('data:indexeddb');

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data';
export const DATABASE_VERSION = 36;

export const CANONICAL_QUERY_INDEX_FIELDS = /** @type {Record<string, string[]>} */ ({
  byQuerySummary: ['summary'],
  byQueryDomain: ['domain'],
  byQueryMcpIdentity: ['source', 'type', 'mcpServer', 'mcpTool']
});

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
  'skills',
  'friction',
  'audits',
  'issues',
  'operationalValues',
  'marketplacePackages',
  'experiments', 'experimentAssignments', 'graders', 'graderObservations', 'evals', 'evalObservations'
]);
export const TRANSACTION_STORE = 'transactions';
export const DATABASE_STORES = /** @type {const} */ ([...ENTITY_STORES, TRANSACTION_STORE]);
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
   indexes: {
     byRun: 'runId',
     byQuerySummary: '_queryKeys.byQuerySummary',
     byQueryDomain: '_queryKeys.byQueryDomain'
   }
 },
 tools: {
   keyPath: 'id',
   indexes: {
     byRun: 'runId',
     byQuerySummary: '_queryKeys.byQuerySummary',
     byQueryMcpIdentity: '_queryKeys.byQueryMcpIdentity',
     byTypeStatusRun: ['type', 'status', 'runId'],
     byTypeStatusRunSummary: ['type', 'status', 'runId', 'summary']
   }
 },
 skills: {
   keyPath: 'id',
   indexes: { byRun: 'runId' }
 },
 friction: {
   keyPath: 'id',
   indexes: { byRun: 'runId' }
 },
 audits: {
   keyPath: 'id',
   indexes: {
     byRun: 'runId',
     byQuerySummary: '_queryKeys.byQuerySummary',
     byTypeStatusRun: ['type', 'status', 'runId'],
     byTypeStatusRunSummary: ['type', 'status', 'runId', 'summary']
   }
  },
  issues: {
    keyPath: 'id',
    indexes: {
      byRun: 'runId',
      byQuerySummary: '_queryKeys.byQuerySummary'
    }
  },
  operationalValues: {
    keyPath: 'id',
    indexes: {
      byRepository: 'repositoryId',
      byValue: 'valueId'
    }
  },
  marketplacePackages: {
    keyPath: 'id',
    indexes: {
      byRegistry: 'registryId',
      byRepository: 'repository'
    }
  },
  experiments: { keyPath: 'id', indexes: { byWorkflow: 'workflowId' } },
  experimentAssignments: { keyPath: 'id', indexes: { byRun: 'runId', byExperiment: 'experimentId' } },
  graders: { keyPath: 'id', indexes: { byWorkflow: 'workflowId' } },
  graderObservations: { keyPath: 'id', indexes: { byRun: 'runId', byGrader: 'graderId' } },
  evals: { keyPath: 'id', indexes: { byWorkflow: 'workflowId' } },
  evalObservations: { keyPath: 'id', indexes: { byRun: 'runId', byEval: 'evalId' } },
  transactions: {
    keyPath: 'id',
    indexes: { byCreatedAt: 'createdAt' }
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
const RETENTION_TIMESTAMPS = new Set([
  'runs',
  'domains',
  'tools',
  'skills',
  'friction',
  'audits',
  'issues',
  'operationalValues',
  'experimentAssignments', 'graderObservations', 'evalObservations'
]);
const RUN_LINKED_STORES = /** @type {const} */ ([
  'domains',
  'tools',
  'skills',
  'friction',
  'audits',
  'issues', 'experimentAssignments', 'graderObservations', 'evalObservations'
]);
const QUERYABLE_STRING_KEY_PATHS = new Set([
  'slug',
  'repositoryId',
  'workflowId',
  'runId',
  'valueId',
  'conclusion',
  'event'
]);
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Physical index keys include absent/null dimensions so native selection never
 * silently drops observations. Query semantics remain in Dashboard Language;
 * these tuples encode raw canonical fields, not computed labels or page state.
 * @param {string} storeName
 * @param {Record<string, unknown>} record
 */
export function prepareCanonicalRecord(storeName, record) {
  const indexes = Object.keys(CANONICAL_DATABASE_SCHEMA[storeName]?.indexes ?? {})
    .filter((name) => Object.hasOwn(CANONICAL_QUERY_INDEX_FIELDS, name));
  if (indexes.length === 0) return record;
  return {
    ...record,
    _queryKeys: Object.fromEntries(indexes.flatMap((name) => {
      const values = CANONICAL_QUERY_INDEX_FIELDS[name].map((field) => record[field] ?? null);
      return values.every((value) => losslessQueryKeyValue(value))
        ? [[name, JSON.stringify(values)]] : [];
    }))
  };
}

/**
 * @param {unknown} value
 * @param {Set<object>} [seen]
 * @param {number} [depth]
 * @returns {boolean}
 */
function losslessQueryKeyValue(value, seen = new Set(), depth = 0) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 64 || seen.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
  seen.add(value);
  const safe = Object.values(value).every((child) => losslessQueryKeyValue(child, seen, depth + 1));
  seen.delete(value);
  return safe;
}

/**
 * @template {Record<string, unknown> | undefined | null} T
 * @param {T} record
 * @returns {T}
 */
function canonicalRecord(record) {
  if (record && Object.hasOwn(record, '_queryKeys')) delete record._queryKeys;
  return record;
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error ?? new Error('IndexedDB request failed');
      debug({ event: 'request-failed', ...errorSummary(error) });
      reject(error);
    };
  });
}

/** @param {IDBTransaction} transaction @param {'error' | 'abort'} outcome */
function reportTransactionFailure(transaction, outcome) {
  debug({
    event: outcome === 'abort' ? 'transaction-aborted' : 'transaction-failed',
    mode: transaction.mode,
    stores: [...(transaction.objectStoreNames ?? [])].join('|'),
    ...errorSummary(transaction.error)
  });
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => {
      reportTransactionFailure(transaction, 'error');
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
    transaction.onabort = () => {
      reportTransactionFailure(transaction, 'abort');
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
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
 * Milliseconds between diagnostics reports while an open request has not
 * settled. A healthy open settles in a few milliseconds; a request that stays
 * pending is waiting on a lock held by another connection (a stale tab, a
 * worker that is mid-upgrade) or on a damaged backing store.
 */
const OPEN_PENDING_REPORT_MS = 2_000;
let nextOpenRequestId = 0;
let pendingOpenRequests = 0;

/** @param {unknown} error */
function errorSummary(error) {
  return error instanceof Error || (error && typeof error === 'object' && 'name' in error)
    ? {
        errorName: String(/** @type {{ name?: unknown }} */ (error).name ?? 'Error'),
        errorMessage: String(/** @type {{ message?: unknown }} */ (error).message ?? '')
      }
    : { errorName: 'Unknown', errorMessage: String(error) };
}

/**
 * Reports browser storage state that explains an open request that does not
 * settle: whether other versions of the canonical database exist, and whether
 * the origin is close to its storage quota. Reports only names, versions, and
 * byte counts.
 * @param {IDBFactory} indexedDB
 * @param {string} name
 * @param {number} openId
 */
async function reportPendingOpenDiagnostics(indexedDB, name, openId) {
  try {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null;
    debug({
      event: 'open-pending-databases',
      openId,
      databasesSupported: databases !== null,
      matching: databases?.filter((database) => database.name === name)
        .map((database) => ({ version: database.version ?? null })) ?? [],
      totalDatabaseCount: databases?.length ?? null
    });
  } catch (error) {
    debug({ event: 'open-pending-databases-failed', openId, ...errorSummary(error) });
  }
  try {
    const storage = globalThis.navigator?.storage;
    const estimate = typeof storage?.estimate === 'function' ? await storage.estimate() : null;
    const persisted = typeof storage?.persisted === 'function' ? await storage.persisted() : null;
    debug({
      event: 'open-pending-storage',
      openId,
      usageBytes: estimate?.usage ?? null,
      quotaBytes: estimate?.quota ?? null,
      persisted
    });
  } catch (error) {
    debug({ event: 'open-pending-storage-failed', openId, ...errorSummary(error) });
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openCanonicalDatabase(indexedDB) {
  const name = canonicalDatabaseName();
  const openId = ++nextOpenRequestId;
  const startedAt = monotonicNow();
  const elapsed = () => Math.round(monotonicNow() - startedAt);
  pendingOpenRequests += 1;
  debug({ event: 'open-requested', openId, version: DATABASE_VERSION, pendingOpenRequests });
  let reports = 0;
  // Reports only while the request is unsettled; debug output is a no-op
  // unless `?debug=` enables the `data:indexeddb` category.
  const pendingReport = setInterval(() => {
    reports += 1;
    debug({ event: 'open-pending', openId, elapsedMs: elapsed(), pendingOpenRequests });
    if (reports === 1) void reportPendingOpenDiagnostics(indexedDB, name, openId);
  }, OPEN_PENDING_REPORT_MS);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    pendingOpenRequests -= 1;
    clearInterval(pendingReport);
  };
  /** @type {IDBOpenDBRequest} */
  let request;
  try {
    request = indexedDB.open(name, DATABASE_VERSION);
  } catch (error) {
    settle();
    debug({ event: 'open-threw', openId, elapsedMs: elapsed(), ...errorSummary(error) });
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const upgrade = request.transaction;
      debug({
        event: 'open-upgrade-needed',
        openId,
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
        existingStoreCount: database.objectStoreNames.length,
        elapsedMs: elapsed()
      });
      if (upgrade) {
        upgrade.addEventListener('abort', () => debug({
          event: 'open-upgrade-aborted', openId, elapsedMs: elapsed(), ...errorSummary(upgrade.error)
        }));
        upgrade.addEventListener('complete', () => debug({
          event: 'open-upgrade-completed', openId, elapsedMs: elapsed()
        }));
      }
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
      settle();
      const database = request.result;
      if (blocked) {
        debug('closing database opened after blocked request settled', name);
        database.close();
        return;
      }
      const missingStores = Object.keys(CANONICAL_DATABASE_SCHEMA)
        .filter((storeName) => !database.objectStoreNames.contains(storeName));
      debug({
        event: missingStores.length > 0 ? 'open-schema-mismatch' : 'open-succeeded',
        openId,
        version: database.version,
        storeCount: database.objectStoreNames.length,
        missingStores,
        elapsedMs: elapsed()
      });
      database.onversionchange = (event) => {
        debug({
          event: 'connection-version-change',
          openId,
          oldVersion: event.oldVersion,
          newVersion: event.newVersion
        });
        debug('closing database for version change', name);
        database.close();
      };
      // `close` fires only when the browser closes the connection abnormally,
      // for example after backing-store corruption or when site data is cleared.
      database.onclose = () => debug({ event: 'connection-closed-abnormally', openId });
      resolve(database);
    };
    request.onerror = () => {
      settle();
      const error = request.error ?? new Error('Unable to open canonical dashboard data');
      debug({ event: 'open-failed', openId, elapsedMs: elapsed(), ...errorSummary(error) });
      debug('failed to open database', name, error);
      reject(error);
    };
    request.onblocked = (event) => {
      settle();
      debug({
        event: 'open-blocked',
        openId,
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
        elapsedMs: elapsed()
      });
      debug('open database blocked by an older connection', name);
      blocked = true;
      reject(new Error('Opening canonical dashboard data was blocked'));
    };
  });
}

/**
 * Upserts a canonical batch onto an already-open database connection using
 * bounded transactions. Callers that write many small batches in sequence
 * (such as streamed JSONL ingestion) should open the connection once with
 * {@link openCanonicalDatabase} and reuse it across calls: repeatedly
 * opening and closing a connection for every batch adds IPC/versioning
 * overhead per call that dominates ingestion time once batch counts grow
 * into the hundreds.
 *
 * @param {IDBDatabase} database
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {{ batchSize?: number, validateRelationships?: boolean, signal?: AbortSignal, onBatchCommitted?: (progress: { committedBatches: number, committedRecords: number }) => void | Promise<void> }} [options]
 */
export async function upsertCanonicalBatchWithConnection(database, batch, options = {}) {
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

  let committedRecords = 0;
  let committedBatches = 0;
  for (const storeName of ENTITY_STORES) {
    options.signal?.throwIfAborted();
    const records = batch[storeName] ?? [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      options.signal?.throwIfAborted();
      const boundedRecords = records.slice(offset, offset + batchSize)
        .map((record) => pruneCanonicalRecord(storeName, record));
      const transaction = readwriteTransaction(database, storeName);
      const done = transactionDone(transaction);
      const store = transaction.objectStore(storeName);
      if (EVIDENCE_DEFINITION_STORES.has(storeName)) {
        let pendingLookups = boundedRecords.length;
        for (const record of boundedRecords) {
          const lookup = store.get(/** @type {IDBValidKey} */ (record.id));
          lookup.onsuccess = () => {
            store.put(mergeEvidenceDefinition(
              /** @type {Record<string, unknown> | undefined} */ (lookup.result), record
            ));
            if (--pendingLookups === 0) commitTransaction(transaction);
          };
        }
      } else {
        for (const record of boundedRecords) store.put(prepareCanonicalRecord(storeName, record));
        commitTransaction(transaction);
      }
      await done;
      committedRecords += boundedRecords.length;
      committedBatches += 1;
      await options.onBatchCommitted?.({ committedBatches, committedRecords });
    }
  }
  return { committedBatches, committedRecords };
}

/**
 * Directly upserts a canonical batch using bounded transactions, opening and
 * closing a database connection for this call only. Prefer
 * {@link upsertCanonicalBatchWithConnection} when writing many batches in a
 * loop so the connection can be reused.
 *
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {{ batchSize?: number, validateRelationships?: boolean, signal?: AbortSignal, onBatchCommitted?: (progress: { committedBatches: number, committedRecords: number }) => void | Promise<void> }} [options]
 */
export async function upsertCanonicalBatch(indexedDB, batch, options = {}) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    return await upsertCanonicalBatchWithConnection(database, batch, options);
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
 * @param {{ now?: number, retentionWindowMs?: number, retentionWindowMsByStore?: Record<string, number>, maxDatabaseBytes: number, usageBytes?: number | null, reconcileRelationships?: boolean, preserveEntityIds?: { repositories?: string[], workflows?: string[] }, onMaintenanceProgress?: (completed: number, total: number) => void, signal?: AbortSignal }} options
 */
export async function maintainCanonicalDatabase(indexedDB, options) {
    options.signal?.throwIfAborted();
    const now = options.now ?? Date.now();
    const defaultWindow = Number.isFinite(options.retentionWindowMs)
      ? Math.max(0, Number(options.retentionWindowMs))
      : 30 * 24 * 60 * 60 * 1000;
    const targetBytes = Math.floor(Math.max(0, options.maxDatabaseBytes) * 0.75);
    let estimatedBytes = 0;
    let deletedRecords = 0;
    let retainedRecords = 0;
    let prunedAudits = 0;
    /** @type {Map<string, Record<string, unknown>>} */
    const auditRunFacts = new Map();
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
      const referencedAudits = new Set();
      for (const storeName of ['graderObservations', 'evalObservations', 'experimentAssignments']) {
        options.signal?.throwIfAborted();
        const transaction = database.transaction(storeName);
        const done = transactionDone(transaction);
        const store = transaction.objectStore(storeName);
        if (typeof store.openCursor !== 'function') {
          for (const record of await requestResult(store.getAll())) {
            if (typeof record.auditId === 'string') referencedAudits.add(record.auditId);
          }
        } else {
          const request = store.openCursor();
          request.onsuccess = () => {
            if (options.signal?.aborted) {
              transaction.abort();
              return;
            }
            const cursor = request.result;
            if (!cursor) return;
            if (typeof cursor.value.auditId === 'string') referencedAudits.add(cursor.value.auditId);
            cursor.continue();
          };
        }
        await done;
      }
      for (const storeName of ENTITY_STORES) {
        options.signal?.throwIfAborted();
        const transaction = readwriteTransaction(database, storeName);
        const done = transactionDone(transaction);
        const store = transaction.objectStore(storeName);
        /** @param {Record<string, unknown>} record @param {() => void} remove */
        const visit = (record, remove) => {
          const id = String(record.id);
          if (storeName === 'runs') auditRunFacts.set(id, auditCurationRunFacts(record));
          if (storeName === 'audits' && !referencedAudits.has(id)
              && discardAudit(canonicalRecord({ ...record }), auditRunFacts.get(String(record.runId)))) {
            remove();
            deletedRecords += 1;
            prunedAudits += 1;
            return;
          }
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
            } else if (['experiments', 'graders', 'evals'].includes(storeName)
              && !workflowRepositories.has(String(record.workflowId))) {
              remove();
              deletedRecords += 1;
              return;
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
            /** @type {IDBValidKey[]} */
            const pendingAuditDeletes = [];
            const flushAuditDeletes = () => {
              for (const key of pendingAuditDeletes) store.delete(key);
              pendingAuditDeletes.length = 0;
            };
            const cursorRequest = store.openCursor();
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
            cursorRequest.onsuccess = () => {
              if (options.signal?.aborted) {
                transaction.abort();
                return;
              }
              const cursor = cursorRequest.result;
              if (!cursor) {
                flushAuditDeletes();
                resolve(undefined);
                return;
              }
              visit(cursor.value, () => {
                if (storeName === 'audits') pendingAuditDeletes.push(cursor.primaryKey);
                else cursor.delete();
              });
              cursor.continue();
              // Per-row deletes invalidate Chromium's cursor prefetch cache.
              if (pendingAuditDeletes.length >= DEFAULT_WRITE_BATCH_SIZE) flushAuditDeletes();
            };
          });
        }
        await done;
        options.onMaintenanceProgress?.(ENTITY_STORES.indexOf(storeName) + 1, ENTITY_STORES.length);
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

      options.signal?.throwIfAborted();
      const receipt = readwriteTransaction(database, TRANSACTION_STORE);
      const receiptDone = transactionDone(receipt);
      receipt.objectStore(TRANSACTION_STORE).put({
        id: AUDIT_CURATION_TRANSACTION_ID,
        kind: 'audit-curation',
        version: AUDIT_CURATION_VERSION,
        createdAt: new Date(now).toISOString()
      });
      await receiptDone;
      debug('curated canonical audits', { prunedAudits, version: AUDIT_CURATION_VERSION });
      return { deletedRecords, estimatedBytes, retainedRecords, prunedAudits };
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
    return Object.fromEntries(storeNames.map((storeName, index) => [
      storeName, records[index].map((record) => canonicalRecord(record))
    ]));
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
    return (await requestResult(database.transaction(storeName).objectStore(storeName).getAll()))
      .map((record) => canonicalRecord(record));
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
 * @param {{ maxRows?: number, onMetrics?: (metrics: { durationMs: number, requestCount: number, recordsScanned: number, recordsReturned: number, index: string | null }) => void }} [options]
 */
export async function queryCollection(indexedDB, storeName, operators, options = {}) {
  const startedAt = monotonicNow();
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(storeName);
    const store = transaction.objectStore(storeName);
    const plan = indexedQueryPlan(store, operators);
    if (options.maxRows !== undefined) {
      const counts = await Promise.all(plan
        ? plan.keys.map((key) => requestResult(plan.index.count(key)))
        : [requestResult(store.count())]);
      if (counts.reduce((sum, count) => sum + count, 0) > options.maxRows) {
        throw new Error(`IndexedDB selection exceeded max-input-rows of ${options.maxRows}`);
      }
    }
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
    const result = tidy(records.map((record) => canonicalRecord(record)), operators);
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
 * Counts distinct index keys without reading their event records. A nullable
 * trailing dimension is recovered by subtracting its indexed counts from the
 * prefix counts: IndexedDB omits null and absent keys, whereas query grouping
 * places both in the same null bucket.
 *
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {{ index: string, nullableIndex?: string, predicates?: import('../../data-operations.js').Predicate[], maxGroups: number, checkpoint?: () => void }} plan
 * @returns {Promise<Record<string, unknown>[] | null>}
 */
export async function queryCollectionCountGroups(indexedDB, storeName, plan) {
  const startedAt = monotonicNow();
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(storeName);
    const done = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    const base = store.index(plan.index);
    if (typeof base.openKeyCursor !== 'function') { await done; return null; }
    // A missing run relationship cannot be silently dropped by an index.
    const [total, indexed, emptyId] = await Promise.all([
      requestResult(store.count()), requestResult(store.index('byRun').count()), requestResult(store.getKey(''))
    ]);
    if (total !== indexed || emptyId !== undefined) {
      await done;
      return null;
    }
    /** @type {Record<string, unknown>[]} */
    const groups = [];
    let requestCount = 3;
    let recordsScanned = 0;
    /**
     * Queue every count and cursor continuation synchronously in each callback,
     * keeping the readonly transaction alive for the entire snapshot.
     * @param {IDBIndex} index
     * @param {(key: IDBValidKey[], count: number, firstKey: IDBValidKey) => void} receive
     */
    const countKeys = (index, receive) => new Promise((resolve, reject) => {
      const fields = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath];
      const cursorRequest = index.openKeyCursor(null, 'nextunique');
      requestCount += 1;
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB count cursor failed'));
      cursorRequest.onsuccess = () => {
        try { plan.checkpoint?.(); } catch (error) { reject(error); return; }
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve(undefined);
          return;
        }
        const key = Array.isArray(cursor.key) ? cursor.key : [cursor.key];
        const row = Object.fromEntries(fields.map((field, i) => [field, key[i]]));
        if (plan.predicates?.length && tidy([row], [{ op: 'filter', predicates: plan.predicates }]).length === 0) {
          cursor.continue();
          return;
        }
        const count = index.count(cursor.key);
        requestCount += 1;
        count.onerror = () => reject(count.error ?? new Error('IndexedDB group count failed'));
        count.onsuccess = () => {
          try {
            receive(key, count.result, cursor.primaryKey);
            cursor.continue();
          } catch (error) {
            reject(error);
          }
        };
      };
    });
    const fields = Array.isArray(base.keyPath) ? base.keyPath : [base.keyPath];
    /** @type {Map<string, { key: IDBValidKey[], count: number }>} */
    const prefixes = new Map();
    const append = (/** @type {Record<string, unknown>} */ row) => {
      if (groups.length + recordsScanned >= plan.maxGroups) throw new Error(`IndexedDB aggregate exceeded max-input-rows of ${plan.maxGroups}`);
      groups.push(row);
    };
    try {
      await countKeys(base, (key, count, firstKey) => {
        if (plan.nullableIndex) {
          if (prefixes.size >= plan.maxGroups) throw new Error(`IndexedDB aggregate exceeded max-input-rows of ${plan.maxGroups}`);
          prefixes.set(JSON.stringify(key), { key, count });
        } else {
          append({ ...Object.fromEntries(fields.map((field, i) => [field, key[i]])), id: firstKey, count });
        }
      });
      if (plan.nullableIndex) {
        const nullable = store.index(plan.nullableIndex);
        const nullableFields = Array.isArray(nullable.keyPath) ? nullable.keyPath : [nullable.keyPath];
        await countKeys(nullable, (key, count, firstKey) => {
          const prefix = prefixes.get(JSON.stringify(key.slice(0, fields.length)));
          if (!prefix) throw new Error('IndexedDB aggregate has an inconsistent prefix count');
          prefix.count -= count;
          append({ ...Object.fromEntries(nullableFields.map((field, i) => [field, key[i]])), id: firstKey, count });
        });
        for (const { key, count } of prefixes.values()) {
          if (count < 0) throw new Error('IndexedDB aggregate has a negative missing-key count');
          if (count === 0) continue;
          const missingField = nullableFields[nullableFields.length - 1];
          // Read only the earliest missing-key representative, preserving
          // explicit null versus absent values and canonical input ordering.
          const representative = await new Promise((resolve, reject) => {
            const request = base.openCursor(Array.isArray(base.keyPath) ? key : key[0]);
            requestCount += 1;
            request.onerror = () => reject(request.error ?? new Error('IndexedDB missing-key lookup failed'));
            request.onsuccess = () => {
              try { plan.checkpoint?.(); } catch (error) { reject(error); return; }
              const cursor = request.result;
              if (!cursor) {
                reject(new Error('IndexedDB aggregate has no missing-key representative'));
                return;
              }
              recordsScanned += 1;
              if (recordsScanned + groups.length > plan.maxGroups) {
                reject(new Error(`IndexedDB aggregate exceeded max-input-rows of ${plan.maxGroups}`));
                return;
              }
              if (cursor.value[missingField] == null) {
                resolve({ id: cursor.primaryKey, value: cursor.value[missingField] });
              } else {
                cursor.continue();
              }
            };
          });
          append({
            ...Object.fromEntries(fields.map((field, i) => [field, key[i]])),
            [missingField]: representative.value,
            id: representative.id,
            count
          });
        }
      }
      await done;
    } catch (error) {
      try { transaction.abort(); } catch { /* Already completed or aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
    debug('completed indexed collection aggregate', {
      store: storeName, index: base.name, executionPath: 'indexed-count',
      durationMs: monotonicNow() - startedAt, requestCount,
      recordsScanned, recordsReturned: groups.length
    });
    return groups.sort((left, right) => indexedDB.cmp(
      /** @type {IDBValidKey} */ (left.id), /** @type {IDBValidKey} */ (right.id)
    ));
  } finally {
    database.close();
  }
}

/**
 * Reads a bounded dictionary of nullable raw-field tuples, not event rows.
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} indexName
 * @param {{ maxKeys: number, checkpoint?: () => void }} options
 * @returns {Promise<Array<{ key: string, row: Record<string, unknown> }> | null>}
 */
export async function readCollectionQueryKeys(indexedDB, storeName, indexName, options) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(storeName);
    const done = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    const index = store.index(indexName);
    if (typeof index.openKeyCursor !== 'function') { await done; return null; }
    const [total, indexed] = await Promise.all([requestResult(store.count()), requestResult(index.count())]);
    if (total !== indexed) {
      await done;
      return null;
    }
    const fields = CANONICAL_QUERY_INDEX_FIELDS[indexName];
    /** @type {Array<{ key: string, row: Record<string, unknown> }>} */
    const rows = [];
    try {
      await new Promise((resolve, reject) => {
        const request = index.openKeyCursor(null, 'nextunique');
        request.onerror = () => reject(request.error ?? new Error('IndexedDB query-key read failed'));
        request.onsuccess = () => {
          try {
            options.checkpoint?.();
            const cursor = request.result;
            if (!cursor) { resolve(undefined); return; }
            if (rows.length >= options.maxKeys) throw new Error(`IndexedDB query keys exceeded max-input-rows of ${options.maxKeys}`);
            const key = String(cursor.key);
            const values = JSON.parse(key);
            if (!Array.isArray(values) || values.length !== fields.length) throw new Error('Invalid canonical query index key');
            rows.push({ key, row: Object.fromEntries(fields.map((field, i) => [field, values[i]])) });
            cursor.continue();
          } catch (error) { reject(error); }
        };
      });
      await done;
    } catch (error) {
      try { transaction.abort(); } catch { /* Already completed or aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
    return rows;
  } finally {
    database.close();
  }
}

/**
 * Materializes only selected tuple keys, after checking their native counts.
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} indexName
 * @param {string[]} keys
 * @param {{ maxRows: number, checkpoint?: () => void }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readCollectionQueryKeyRecords(indexedDB, storeName, indexName, keys, options) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const index = database.transaction(storeName).objectStore(storeName).index(indexName);
    const unique = [...new Set(keys)];
    const counts = await Promise.all(unique.map((key) => requestResult(index.count(key))));
    options.checkpoint?.();
    if (counts.reduce((sum, count) => sum + count, 0) > options.maxRows) {
      throw new Error(`IndexedDB selection exceeded max-input-rows of ${options.maxRows}`);
    }
    const records = await Promise.all(unique.map((key) => requestResult(index.getAll(key))));
    options.checkpoint?.();
    return records.flat().map((record) => canonicalRecord(record)).sort((left, right) => indexedDB.cmp(
      /** @type {IDBValidKey} */ (left.id), /** @type {IDBValidKey} */ (right.id)
    ));
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
 * Reads a canonical record from an already-open database connection. Prefer
 * this over {@link readRecord} when reading many records in a loop (such as
 * per-record structural-metadata merges) so the connection can be reused
 * instead of reopened for each read.
 *
 * @param {IDBDatabase} database
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} id
 */
export async function readRecordWithConnection(database, storeName, id) {
  const result = await requestResult(database.transaction(storeName).objectStore(storeName).get(id));
  return result && typeof result === 'object' ? canonicalRecord(result) : null;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} id
 */
export async function readRecord(indexedDB, storeName, id) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    return await readRecordWithConnection(database, storeName, id);
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
      return (await requestResult(index.getAll(key[0]))).map((record) => canonicalRecord(record));
    }
    return (await requestResult(index.getAll(
      IDBKeyRange.bound(key, [...key, []], false, true)
    ))).map((record) => canonicalRecord(record));
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
    return [storeName, (batch[storeName] ?? []).map((record) => pruneCanonicalRecord(storeName, record)).filter((record) => {
      const retained = previous.get(String(record.id));
      return retained !== record
        && (!retained || JSON.stringify(retained) !== JSON.stringify(record));
    })];
  }));
  const previousBatch = options.previousBatch;
  const recordsToDelete = previousBatch
    ? Object.fromEntries(ENTITY_STORES.map((storeName) => {
        const retained = new Set((batch[storeName] ?? []).map((record) => String(record.id)));
        return [storeName, (previousBatch[storeName] ?? [])
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
      const records = batch[storeName] ?? [];
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
          for (const record of boundedRecords) store.put(prepareCanonicalRecord(storeName, record));
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
    const persistentReceipt = (candidate) => (
      candidate?.kind === 'dashboard-snapshot'
      || (candidate?.kind === 'ingest-normalized-jsonl' && typeof candidate.payloadHash === 'string')
    );
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
