import { canonicalJson } from '../normalize/order.js';
import { dashboardPagePath, scopedStorageKey } from '../../storage-scope.js';
import { createDebug } from '../../debug.js';
import {
  beginMetricScope, COMPACT_METRIC_PRECEDENCE, completeCompactMetricScope, createCompactMetricLedger,
  MAX_SCOPE_RUNS, stageMetricShard
} from './daily-metrics.js';
import { logicalWatermark, tierIdentifier } from './tiering.js';

const debug = createDebug('data:metric-staging');
export const METRIC_STAGING_DATABASE = 'gh-aw-cao-metric-staging';
const VERSION = 1;
const STORES = ['scopes', 'shards', 'ledgers', 'contributions', 'metrics'];

/** @typedef {import('./daily-metrics.js').MetricScope} MetricScope */
/** @typedef {import('./daily-metrics.js').CompactMetricLedger} CompactMetricLedger */
/** @typedef {{ namespace: string, scopeId: string, revision: number, watermark: number }} MetricCommitReceipt */
/** @typedef {Omit<MetricScope, 'shards'> & { receivedShards: number, observations: number }} StoredScope */
/** @typedef {{ key: string, version: number, scope: Omit<MetricScope, 'shards'>, receivedShards: number, observations: number, committed?: MetricCommitReceipt }} ScopeRow */
/** @typedef {{ key: string, runs: Record<string, unknown>[] }} ShardRow */
/** @typedef {{ key: string, revision: number, initialWatermark: number, contributionCount: number, metricCount: number, state: Omit<CompactMetricLedger, 'contributions' | 'dailyMetrics'> }} LedgerRow */
/** @template V @typedef {{ key: string, namespace: string, id: string, value: V }} MetricRow */

export class MetricLedgerConflictError extends Error {
  constructor() {
    super('Metric ledger changed during reduction; retry from the committed revision');
    this.name = 'MetricLedgerConflictError';
  }
}

class MetricScopeCommittedError extends Error {
  /** @param {MetricCommitReceipt} receipt */
  constructor(receipt) {
    super('Metric scope is already committed');
    this.name = 'MetricScopeCommittedError';
    this.receipt = receipt;
  }
}

/** @param {string} namespace @param {string} scopeId */
function scopeKey(namespace, scopeId) {
  return canonicalJson([tierIdentifier(namespace, 'namespace'), tierIdentifier(scopeId, 'scope.id')]);
}

/** @param {ScopeRow} row @param {string} key */
function validateScopeRow(row, key) {
  if (row.version !== VERSION) throw new Error('Unsupported stored metric scope version');
  const scope = beginMetricScope(row.scope);
  if (scopeKey(scope.namespace, scope.id) !== key
    || !Number.isSafeInteger(row.observations) || row.observations < 0 || row.observations > MAX_SCOPE_RUNS
    || !Number.isSafeInteger(row.receivedShards) || row.receivedShards < 0
    || row.receivedShards > scope.expectedShards.length) {
    throw new Error('Stored metric scope identity or receipt counts are inconsistent');
  }
  if (row.committed && (row.receivedShards !== scope.expectedShards.length
    || row.committed.namespace !== scope.namespace || row.committed.scopeId !== scope.id
    || row.committed.watermark !== scope.watermark || !Number.isSafeInteger(row.committed.revision)
    || row.committed.revision < 1)) throw new Error('Stored metric completion receipt is inconsistent');
  return scope;
}

/** @param {LedgerRow} row @param {string} namespace */
function validateLedgerRow(row, namespace) {
  if (row.state.version !== 1 || row.state.precedenceFormat !== COMPACT_METRIC_PRECEDENCE) {
    throw new Error('Unsupported stored metric ledger format');
  }
  if (row.state.namespace !== namespace || !Number.isSafeInteger(row.revision) || row.revision < 0
    || ![row.contributionCount, row.metricCount].every((count) => Number.isSafeInteger(count) && count >= 0)
    || logicalWatermark(row.initialWatermark) > logicalWatermark(row.state.watermark)) {
    throw new Error('Invalid stored metric ledger metadata');
  }
}

/** @param {IDBFactory} factory @param {string | undefined} pathname @returns {Promise<IDBDatabase>} */
function openDatabase(factory, pathname) {
  return new Promise((resolve, reject) => {
    const request = factory.open(scopedStorageKey(METRIC_STAGING_DATABASE, pathname), VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('scopes', { keyPath: 'key' });
      request.result.createObjectStore('shards', { keyPath: 'key' });
      request.result.createObjectStore('ledgers', { keyPath: 'key' });
      for (const name of ['contributions', 'metrics']) {
        request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('byNamespace', 'namespace');
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Metric staging database upgrade is blocked by another connection'));
    };
    request.onerror = () => reject(request.error ?? new Error('Metric staging database open failed'));
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/**
 * All database work stays in request callbacks, never across an async hash or
 * other non-IDB await. Resolve only after the transaction commits.
 * @template T
 * @param {IDBDatabase} database
 * @param {'readonly' | 'readwrite'} mode
 * @param {(read: <V>(store: string, key: string, next: (value: V | undefined) => void, index?: string) => void,
 *   transaction: IDBTransaction, result: (value: T) => void) => void} operation
 * @returns {Promise<T>}
 */
function transact(database, mode, operation) {
  return new Promise((resolve, reject) => {
    // No relaxed-durability fallback: a receipt must not acknowledge a cache-only write.
    const transaction = database.transaction(STORES, mode,
      mode === 'readwrite' ? { durability: 'strict' } : undefined);
    /** @type {T} */
    let result;
    /** @type {unknown} */
    let failure;
    let stopped = false;
    transaction.oncomplete = () => resolve(result);
    const rejectTransaction = () => {
      stopped = true;
      debug({ event: 'transaction-failed', mode });
      reject(failure ?? transaction.error ?? new Error('Metric staging transaction aborted'));
    };
    transaction.onabort = rejectTransaction;
    transaction.onerror = () => debug({ event: 'request-failed', mode });
    const guard = (/** @type {() => void} */ action) => {
      if (stopped) return;
      try {
        action();
      } catch (error) {
        failure = error;
        stopped = true;
        transaction.abort();
      }
    };
    guard(() => operation((store, key, next, index) => {
      const target = transaction.objectStore(store);
      const request = index ? target.index(index).getAll(key) : target.get(key);
      request.onsuccess = () => guard(() => next(request.result));
    }, transaction, (value) => { result = value; }));
  });
}

/** @param {unknown} value */
function requireJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || (!Array.isArray(value)
    && Object.prototype.toString.call(value) !== '[object Object]')) {
    throw new TypeError('Metric staging requires lossless finite JSON records');
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) requireJson(child);
}

/**
 * Creates an immutable scope declaration. Reusing an identity with changed
 * watermark or shard membership rejects instead of replacing staged evidence.
 * This staging database is separate from queryable canonical stores.
 * @param {IDBFactory} factory
 * @param {Parameters<typeof beginMetricScope>[0]} options
 * @param {{ pathname?: string }} [storage]
 */
export async function beginStoredMetricScope(factory, options, storage = {}) {
  const { id, namespace, watermark, expectedShards } = beginMetricScope(options);
  const scope = { id, namespace, watermark, expectedShards };
  const key = scopeKey(scope.namespace, scope.id);
  const database = await openDatabase(factory, storage.pathname);
  try {
    return await transact(database, 'readwrite', (read, transaction, result) => {
      read('scopes', key, (/** @type {ScopeRow | undefined} */ previous) => {
        if (previous) validateScopeRow(previous, key);
        if (previous && canonicalJson(previous.scope) !== canonicalJson(scope)) {
          throw new Error('Metric scope identity changed declaration');
        }
        if (!previous) transaction.objectStore('scopes').put({
          key, version: VERSION, scope, receivedShards: 0, observations: 0
        });
        result(scope);
      });
    });
  } finally {
    database.close();
  }
}

/**
 * Atomically stores one bounded shard and its receipt counts. Exact reordered
 * JSON retries are idempotent; changing a shard under its identity fails closed.
 * @param {IDBFactory} factory
 * @param {{ namespace: string, scopeId: string, shardId: string, runs: Record<string, unknown>[] }} options
 * @param {{ pathname?: string }} [storage]
 */
export async function stageStoredMetricShard(factory, options, storage = {}) {
  const key = scopeKey(options.namespace, options.scopeId);
  const shardId = tierIdentifier(options.shardId, 'shard identity');
  // Reuse the reducer's per-shard validation and canonical record ordering.
  const checked = stageMetricShard(beginMetricScope({
    id: options.scopeId, namespace: options.namespace, watermark: 0, expectedShards: [shardId]
  }), shardId, options.runs);
  const ordered = checked.shards[canonicalJson([shardId])];
  requireJson(ordered);
  const shardKey = canonicalJson([options.namespace, options.scopeId, shardId]);
  const database = await openDatabase(factory, storage.pathname);
  try {
    return await transact(database, 'readwrite', (read, transaction, result) => {
      read('scopes', key, (/** @type {ScopeRow | undefined} */ previous) => {
        if (!previous) throw new Error('Metric scope has not been declared');
        validateScopeRow(previous, key);
        if (previous.committed) throw new Error('Metric scope is already committed');
        if (!previous.scope.expectedShards.includes(shardId)) throw new Error('Undeclared metric shard');
        read('shards', shardKey, (/** @type {ShardRow | undefined} */ existing) => {
          if (existing && canonicalJson(existing.runs) !== canonicalJson(ordered)) {
            throw new Error('Metric shard identity changed content');
          }
          if (!existing) {
            if (previous.observations + ordered.length > MAX_SCOPE_RUNS) {
              throw new RangeError('Metric scope exceeds bounded run count');
            }
            transaction.objectStore('shards').put({ key: shardKey, runs: ordered });
            previous.receivedShards += 1;
            previous.observations += ordered.length;
            transaction.objectStore('scopes').put(previous);
          }
          result(/** @type {StoredScope} */ ({
            ...previous.scope, receivedShards: previous.receivedShards, observations: previous.observations
          }));
        });
      });
    });
  } finally {
    database.close();
  }
}

/**
 * Recovers one complete scope from a single readonly snapshot. Incomplete scopes
 * reject; no prefix may become an aggregate commit candidate. This materializes
 * at most the reducer's 100,000 observations, not the entire staging database.
 * Recovery does not discard staging or prove any metric checkpoint was committed.
 * @param {IDBFactory} factory
 * @param {{ namespace: string, scopeId: string }} options
 * @param {{ pathname?: string }} [storage]
 * @returns {Promise<MetricScope>}
 */
export async function readStoredMetricScope(factory, options, storage = {}) {
  const key = scopeKey(options.namespace, options.scopeId);
  const database = await openDatabase(factory, storage.pathname);
  try {
    return await transact(database, 'readonly', (read, _transaction, result) => {
      read('scopes', key, (/** @type {ScopeRow | undefined} */ stored) => {
        if (!stored) throw new Error('Metric scope has not been declared');
        const scope = validateScopeRow(stored, key);
        if (stored.committed) throw new MetricScopeCommittedError(stored.committed);
        if (stored.receivedShards !== scope.expectedShards.length) throw new Error('Metric scope is incomplete');
        let received = 0;
        let observations = 0;
        for (const shardId of scope.expectedShards) {
          read('shards', canonicalJson([scope.namespace, scope.id, shardId]), (/** @type {ShardRow | undefined} */ shard) => {
            if (!shard) throw new Error('Metric scope receipt is missing its staged shard');
            requireJson(shard.runs);
            const staged = stageMetricShard({ ...scope, shards: {} }, shardId, shard.runs);
            observations += shard.runs.length;
            if (observations > MAX_SCOPE_RUNS) throw new RangeError('Metric scope exceeds bounded run count');
            scope.shards[canonicalJson([shardId])] = staged.shards[canonicalJson([shardId])];
            received += 1;
            if (received === scope.expectedShards.length) {
              if (observations !== stored.observations) throw new Error('Metric scope receipt count is inconsistent');
              result(scope);
            }
          });
        }
      });
    });
  } finally {
    database.close();
  }
}

/**
 * Initializes an immutable ledger authority policy. Repeating the same bootstrap
 * does not reset a ledger whose watermark or checkpoint has advanced.
 * @param {IDBFactory} factory
 * @param {{ namespace: string, watermark: number, sourcePrecedence?: Record<string, number> }} options
 * @param {{ pathname?: string }} [storage]
 * @returns {Promise<void>}
 */
export async function beginStoredMetricLedger(factory, options, storage = {}) {
  const state = ledgerMetadata(createCompactMetricLedger(
    options.namespace, options.watermark, options.sourcePrecedence));
  const key = state.namespace;
  const database = await openDatabase(factory, storage.pathname);
  try {
    return await transact(database, 'readwrite', (read, transaction, result) => {
      read('ledgers', key, (/** @type {LedgerRow | undefined} */ previous) => {
        if (previous) {
          validateLedgerRow(previous, key);
          if (previous.initialWatermark !== state.watermark
            || canonicalJson(previous.state.sourcePrecedence) !== canonicalJson(state.sourcePrecedence)) {
            throw new Error('Metric ledger bootstrap changed authority or initial watermark');
          }
        } else {
          transaction.objectStore('ledgers').put({
            key, revision: 0, initialWatermark: state.watermark, contributionCount: 0, metricCount: 0, state
          });
        }
        result(undefined);
      });
    });
  } finally {
    database.close();
  }
}

/** @param {CompactMetricLedger} ledger */
function ledgerMetadata(ledger) {
  const { version, namespace, watermark, sourcePrecedence, checkpoint, precedenceFormat } = ledger;
  return { version, namespace, watermark, sourcePrecedence, checkpoint, precedenceFormat };
}

/**
 * @template V
 * @param {IDBTransaction} transaction
 * @param {string} name
 * @param {string} namespace
 * @param {Record<string, V>} previous
 * @param {Record<string, V>} next
 */
function writeMetricDelta(transaction, name, namespace, previous, next) {
  const rows = transaction.objectStore(name);
  for (const id of Object.keys(previous)) {
    if (!Object.hasOwn(next, id)) rows.delete(canonicalJson([namespace, id]));
  }
  for (const [id, value] of Object.entries(next)) {
    if (!Object.hasOwn(previous, id) || canonicalJson(previous[id]) !== canonicalJson(value)) {
      rows.put({ key: canonicalJson([namespace, id]), namespace, id, value });
    }
  }
}

/**
 * Reads just one namespace. The prototype reducer still materializes its retained
 * ledger; this API does not claim bounded enterprise-scale ledger memory.
 * @param {IDBFactory} factory
 * @param {string} namespace
 * @param {{ pathname?: string }} [storage]
 * @returns {Promise<{ revision: number, ledger: CompactMetricLedger }>}
 */
export async function readStoredMetricLedger(factory, namespace, storage = {}) {
  const key = tierIdentifier(namespace, 'namespace');
  const database = await openDatabase(factory, storage.pathname);
  try {
    return await transact(database, 'readonly', (read, _transaction, result) => {
      read('ledgers', key, (/** @type {LedgerRow | undefined} */ meta) => {
        if (!meta) throw new Error('Metric ledger has not been initialized');
        validateLedgerRow(meta, key);
        read('contributions', key, (/** @type {MetricRow<CompactMetricLedger['contributions'][string]>[] | undefined} */ contributions) => {
          if (!contributions) throw new Error('Metric contribution snapshot is unavailable');
          read('metrics', key, (/** @type {MetricRow<CompactMetricLedger['dailyMetrics'][string]>[] | undefined} */ metrics) => {
            if (!metrics) throw new Error('Daily metric snapshot is unavailable');
            // The SQLite compatibility adapter has no readonly BEGIN snapshot.
            // Recheck the fence so a cross-process write cannot publish mixed rows.
            read('ledgers', key, (/** @type {LedgerRow | undefined} */ current) => {
              if (!current || current.revision !== meta.revision) throw new MetricLedgerConflictError();
              if (contributions.length !== meta.contributionCount || metrics.length !== meta.metricCount) {
                throw new Error('Stored metric ledger row counts are inconsistent');
              }
              result({
                revision: meta.revision,
                ledger: {
                  ...meta.state,
                  contributions: Object.fromEntries(contributions.map((row) => [row.id, row.value])),
                  dailyMetrics: Object.fromEntries(metrics.map((row) => [row.id, row.value]))
                }
              });
            });
          }, 'byNamespace');
        }, 'byNamespace');
      });
    });
  } finally {
    database.close();
  }
}

/**
 * Applies a complete stored scope outside the write transaction, then atomically
 * fences its ledger revision, writes changed rows/checkpoint, records a completion
 * receipt, and removes staged raw shards. Conflicts retain staging for retry.
 * No canonical Run or detail is deleted.
 * @param {IDBFactory} factory
 * @param {{ namespace: string, scopeId: string }} options
 * @param {{ pathname?: string }} [storage]
 * @returns {Promise<MetricCommitReceipt>}
 */
export async function completeStoredMetricScope(factory, options, storage = {}) {
  const namespace = tierIdentifier(options.namespace, 'namespace');
  const key = scopeKey(namespace, options.scopeId);
  const identity = { namespace, scopeId: options.scopeId };
  const location = { pathname: storage.pathname ?? dashboardPagePath() };
  let scope;
  try {
    scope = await readStoredMetricScope(factory, identity, location);
  } catch (error) {
    if (error instanceof MetricScopeCommittedError) return error.receipt;
    throw error;
  }
  const snapshot = await readStoredMetricLedger(factory, namespace, location);
  const candidate = await completeCompactMetricScope(snapshot.ledger, scope);
  if (snapshot.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Metric ledger revision overflow');
  const committed = { ...identity, revision: snapshot.revision + 1, watermark: candidate.watermark };
  const state = ledgerMetadata(candidate);
  const database = await openDatabase(factory, location.pathname);
  try {
    return await transact(database, 'readwrite', (read, transaction, result) => {
      read('scopes', key, (/** @type {ScopeRow | undefined} */ stored) => {
        if (!stored) throw new Error('Metric scope has not been declared');
        validateScopeRow(stored, key);
        if (stored.committed) {
          result(stored.committed);
          return;
        }
        read('ledgers', namespace, (/** @type {LedgerRow | undefined} */ meta) => {
          if (!meta || meta.revision !== snapshot.revision) throw new MetricLedgerConflictError();
          writeMetricDelta(transaction, 'contributions', namespace, snapshot.ledger.contributions, candidate.contributions);
          writeMetricDelta(transaction, 'metrics', namespace, snapshot.ledger.dailyMetrics, candidate.dailyMetrics);
          transaction.objectStore('ledgers').put({
            ...meta, revision: committed.revision, state,
            contributionCount: Object.keys(candidate.contributions).length,
            metricCount: Object.keys(candidate.dailyMetrics).length
          });
          transaction.objectStore('scopes').put({ ...stored, committed });
          for (const shardId of scope.expectedShards) {
            transaction.objectStore('shards').delete(canonicalJson([namespace, scope.id, shardId]));
          }
          result(committed);
        });
      });
    });
  } finally {
    database.close();
  }
}
