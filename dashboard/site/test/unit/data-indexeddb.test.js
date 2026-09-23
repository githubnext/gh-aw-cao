import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalDatabaseName,
  countCollections,
  DATABASE_NAME,
  DATABASE_VERSION,
  deleteCanonicalDatabase,
  maintainCanonicalDatabase,
  openCanonicalDatabase,
  publishDailyOverviewAggregates,
  pruneStaleDailyOverviewAggregates,
  queryCollection,
  readCollection,
  readCollections,
  readDailyOverviewAggregates,
  readRecord,
  readTransactions,
  recordTransaction,
  replaceCanonicalBatch,
  upsertCanonicalBatch,
  withCanonicalIngestionLock
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';
import { tidy } from '../../src/data-operations.js';

const LEGACY_PACKAGES_DATABASE_VERSION = 17;

function batch() {
  return normalize([
    {
      kind: 'repository',
      source: 'fixture',
      sourceId: 'repo-1',
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: 'repository:1', fullName: 'githubnext/gh-aw-cao' }
    }
  ]);
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
 * @param {{ id: string, kind: string, createdAt: string, owner?: string, expiresAt?: unknown }} record
 */
async function writeTransactionRecord(record) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction('transactions', 'readwrite');
    transaction.objectStore('transactions').put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/** @param {string} storeName @param {Record<string, unknown>[]} records */
async function writeRecords(storeName, records) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const record of records) store.put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('canonical IndexedDB', () => {
  it('maintains retention and size limits without loading whole stores', async () => {
    await writeRecords('repositories', [{ id: 'repository:1' }]);
    await writeRecords('runs', [
      { id: 'run:expired', observedAt: '2026-01-01T00:00:00Z' },
      { id: 'run:current', observedAt: '2026-09-09T00:00:00Z' }
    ]);
    await writeRecords('audits', [
      { id: 'audit:expired-run', runId: 'run:expired', observedAt: '2026-09-09T00:00:00Z' },
      { id: 'audit:current-run', runId: 'run:current', observedAt: '2026-09-09T00:00:00Z' }
    ]);

    await maintainCanonicalDatabase(indexedDB, {
      now: Date.parse('2026-09-10T00:00:00Z'),
      retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    });

    expect(await readCollection(indexedDB, 'runs')).toEqual([
      expect.objectContaining({ id: 'run:current' })
    ]);
    expect(await readCollection(indexedDB, 'audits')).toEqual([
      expect.objectContaining({ id: 'audit:current-run' })
    ]);

    await maintainCanonicalDatabase(indexedDB, {
      now: Date.parse('2026-09-10T00:00:00Z'),
      retentionWindowMs: Number.MAX_SAFE_INTEGER,
      maxDatabaseBytes: 0
    });

    expect(await readCollection(indexedDB, 'runs')).toEqual([]);
    expect(await readCollection(indexedDB, 'audits')).toEqual([]);
    expect(await readCollection(indexedDB, 'repositories')).toEqual([{ id: 'repository:1' }]);
  });

  it('evicts oldest run subtrees first to meet a finite size limit', async () => {
    const timestamps = [
      '2026-09-07T00:00:00Z',
      '2026-09-08T00:00:00Z',
      '2026-09-09T00:00:00Z'
    ];
    await writeRecords('runs', timestamps.map((observedAt, index) => ({
      id: `run:${index}`,
      observedAt
    })));
    await writeRecords('audits', timestamps.map((observedAt, index) => ({
      id: `audit:${index}`,
      runId: `run:${index}`,
      observedAt
    })));

    await maintainCanonicalDatabase(indexedDB, {
      now: Date.parse('2026-09-10T00:00:00Z'),
      retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      maxDatabaseBytes: 3_000
    });

    const retainedRuns = await readCollection(indexedDB, 'runs');
    expect(retainedRuns).toContainEqual(expect.objectContaining({ id: 'run:2' }));
    expect(retainedRuns).not.toContainEqual(expect.objectContaining({ id: 'run:0' }));
    expect(retainedRuns.length).toBeGreaterThan(0);
    expect(retainedRuns.length).toBeLessThan(3);
    expect((await readCollection(indexedDB, 'audits')).map((record) => record.runId))
      .toEqual(retainedRuns.map((record) => record.id));
  });

  it('initializes the simplified database schema', async () => {
    const database = await openCanonicalDatabase(indexedDB);

    expect([...database.objectStoreNames]).toEqual([
      'audits',
      'campaigns',
      'dailyOverviewAggregates',
      'domains',
      'issues',
      'overviewAggregateMetadata',
      'repositories',
      'runs',
      'tools',
      'transactions',
      'workflows'
    ]);
    expect(database.transaction('repositories').objectStore('repositories').keyPath).toBe('id');
    expect([...database.transaction('repositories').objectStore('repositories').indexNames]).toEqual([]);
    expect([...database.transaction('workflows').objectStore('workflows').indexNames]).toEqual(['byRepository']);
    expect([...database.transaction('runs').objectStore('runs').indexNames])
      .toEqual(['byConclusion', 'byRepository', 'byWorkflow']);
    expect([...database.transaction('domains').objectStore('domains').indexNames]).toEqual(['byRun']);
    expect([...database.transaction('tools').objectStore('tools').indexNames]).toEqual(['byRun']);
    expect([...database.transaction('audits').objectStore('audits').indexNames]).toEqual(['byRun']);
    expect([...database.transaction('issues').objectStore('issues').indexNames]).toEqual(['byRun']);
    expect([...database.transaction('transactions').objectStore('transactions').indexNames]).toEqual(['byCreatedAt']);
    expect([...database.transaction('dailyOverviewAggregates').objectStore('dailyOverviewAggregates').indexNames])
      .toEqual(['byGenerationDay']);
    expect([...database.transaction('overviewAggregateMetadata').objectStore('overviewAggregateMetadata').indexNames])
      .toEqual([]);
    database.close();
  });

  it('initializes the database for an empty collection request', async () => {
    await expect(readCollections(indexedDB, [])).resolves.toEqual({});

    const database = await openCanonicalDatabase(indexedDB);
    expect([...database.objectStoreNames]).toContain('repositories');
    database.close();
  });

  it('counts multiple collections without materializing their records', async () => {
    await writeRecords('repositories', [
      { id: 'repository:1' },
      { id: 'repository:2' }
    ]);
    await writeRecords('runs', [
      { id: 'run:1' },
      { id: 'run:2' },
      { id: 'run:3' }
    ]);
    const nativeCounts = vi.spyOn(IDBObjectStore.prototype, 'count');
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');

    await expect(countCollections(indexedDB, ['repositories', 'runs'])).resolves.toEqual({
      repositories: 2,
      runs: 3
    });
    expect(nativeCounts).toHaveBeenCalledTimes(2);
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('rebuilds disposable canonical stores during upgrade', async () => {
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 9);
      request.onupgradeneeded = () => {
        const repositories = request.result.createObjectStore('repositories', { keyPath: 'id' });
        repositories.put({
          id: 'repository:dashboard-sources:githubnext%2Fgh-aw-cao',
          fullName: 'githubnext/gh-aw-cao'
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();

    const database = await openCanonicalDatabase(indexedDB);

    expect(database.version).toBe(DATABASE_VERSION);
    expect([...database.objectStoreNames]).toEqual([
      'audits',
      'campaigns',
      'dailyOverviewAggregates',
      'domains',
      'issues',
      'overviewAggregateMetadata',
      'repositories',
      'runs',
      'tools',
      'transactions',
      'workflows'
    ]);
    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
    database.close();
  });

  it('rebuilds package-store caches during the campaigns schema upgrade', async () => {
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, LEGACY_PACKAGES_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const packages = request.result.createObjectStore('packages', { keyPath: 'id' });
        packages.createIndex('bySlug', 'slug');
        packages.put({
          id: 'package:dashboard-sources:dashboard',
          slug: 'dashboard'
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(legacy.version).toBe(LEGACY_PACKAGES_DATABASE_VERSION);
    expect([...legacy.objectStoreNames]).toContain('packages');
    legacy.close();

    const database = await openCanonicalDatabase(indexedDB);

    expect(database.version).toBe(DATABASE_VERSION);
    expect([...database.objectStoreNames]).toEqual([
      'audits',
      'campaigns',
      'dailyOverviewAggregates',
      'domains',
      'issues',
      'overviewAggregateMetadata',
      'repositories',
      'runs',
      'tools',
      'transactions',
      'workflows'
    ]);
    expect([...database.objectStoreNames]).not.toContain('packages');
    expect(() => database.transaction('packages')).toThrow();
    expect(await readCollection(indexedDB, 'campaigns')).toEqual([]);
    database.close();
  });

  it('directly upserts records for immediate queries', async () => {
    await upsertCanonicalBatch(indexedDB, batch());

    expect(await readCollection(indexedDB, 'repositories')).toEqual([
      expect.objectContaining({ id: 'repository:1', fullName: 'githubnext/gh-aw-cao' })
    ]);
    expect(await readRecord(indexedDB, 'repositories', 'repository:1')).toMatchObject({
      fullName: 'githubnext/gh-aw-cao'
    });
  });

  it('makes duplicate writes idempotent through entity IDs', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    await upsertCanonicalBatch(indexedDB, canonicalBatch);

    expect(await readCollection(indexedDB, 'repositories')).toHaveLength(1);
  });

  it('reads selected stores through one readonly transaction', async () => {
    const canonicalBatch = normalize([]);
    canonicalBatch.repositories = [{ id: 'repository:1' }];
    canonicalBatch.campaigns = [{ id: 'campaign:1' }];
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');

    const collections = await readCollections(indexedDB, ['repositories', 'campaigns']);

    expect(collections).toEqual({
      repositories: canonicalBatch.repositories,
      campaigns: canonicalBatch.campaigns
    });
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(transactions).toHaveBeenCalledWith(['repositories', 'campaigns']);
    transactions.mockRestore();
  });

  it('requests relaxed durability and explicitly commits bounded writes', async () => {
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const commits = vi.spyOn(IDBTransaction.prototype, 'commit');

    await upsertCanonicalBatch(indexedDB, batch());

    expect(transactions).toHaveBeenCalledWith(
      'repositories',
      'readwrite',
      { durability: 'relaxed' }
    );
    expect(commits).toHaveBeenCalledOnce();
    transactions.mockRestore();
    commits.mockRestore();
  });

  it('falls back when transaction durability options are unsupported', async () => {
    const originalTransaction = IDBDatabase.prototype.transaction;
    /** @type {number[]} */
    const argumentCounts = [];
    IDBDatabase.prototype.transaction = /** @type {typeof IDBDatabase.prototype.transaction} */ (
      function transactionWithoutOptions(...args) {
        argumentCounts.push(args.length);
        if (args.length === 3) throw new TypeError('transaction options are unsupported');
        return originalTransaction.apply(this, args);
      }
    );

    try {
      await upsertCanonicalBatch(indexedDB, batch());
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }

    expect(argumentCounts.slice(-2)).toEqual([3, 2]);
    expect(await readCollection(indexedDB, 'repositories')).toHaveLength(1);
  });

  it('logs transaction compatibility and reconciliation access paths', async () => {
    const debug = vi.fn();
    vi.resetModules();
    vi.doMock('../../src/debug.js', () => ({ createDebug: () => debug }));
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = /** @type {typeof IDBDatabase.prototype.transaction} */ (
      function transactionWithoutOptions(...args) {
        if (args.length === 3) throw new TypeError('transaction options are unsupported');
        return originalTransaction.apply(this, args);
      }
    );
    const storage = await import('../../src/data/storage/indexeddb.js');
    const canonicalBatch = batch();

    try {
      await storage.replaceCanonicalBatch(indexedDB, canonicalBatch, {
        previousBatch: normalize([])
      });
      await storage.readCollections(indexedDB, ['repositories', 'campaigns']);
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
      vi.doUnmock('../../src/debug.js');
    }

    expect(debug).toHaveBeenCalledWith(
      'relaxed transaction durability unsupported; using default durability',
      { storeCount: 1 }
    );
    expect(debug).toHaveBeenCalledWith('explicitly committing queued IndexedDB requests');
    expect(debug).toHaveBeenCalledWith(
      'completed canonical store eviction',
      expect.objectContaining({ reconciliationStrategy: 'retained-snapshot' })
    );
    expect(debug).toHaveBeenCalledWith(
      'completed multi-store collection read',
      expect.objectContaining({ storeCount: 2, requestCount: 2 })
    );
  });

  it('compiles indexed predicates while preserving JavaScript query semantics', async () => {
    const records = [
      { id: 'run:3', conclusion: 'failure', startedAt: '2026-09-03T00:00:00Z' },
      { id: 'run:1', conclusion: 'success', startedAt: '2026-09-01T00:00:00Z' },
      { id: 'run:4', conclusion: 'timed-out', startedAt: '2026-09-04T00:00:00Z' },
      { id: 'run:2', conclusion: 'failure', startedAt: '2026-09-03T00:00:00Z' }
    ];
    const operators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([
      {
        op: 'filter',
        predicates: [{ field: 'conclusion', in: ['failure', 'timed-out'] }]
      },
      { op: 'arrange', by: [{ field: 'startedAt', direction: 'desc' }] },
      { op: 'slice', limit: 2 }
    ]);
    await writeRecords('runs', records);
    const stored = await readCollection(indexedDB, 'runs');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'runs', operators);

    expect(result).toEqual(tidy(stored, operators));
    expect(indexedReads).toHaveBeenCalledTimes(2);
    indexedReads.mockRestore();
  });

  it('reports query access-plan measurements', async () => {
    await writeRecords('runs', [
      { id: 'run:1', conclusion: 'failure' },
      { id: 'run:2', conclusion: 'success' },
      { id: 'run:3', conclusion: 'failure' }
    ]);
    const metrics = vi.fn();

    const result = await queryCollection(indexedDB, 'runs', [{
      op: 'filter',
      predicates: [{ field: 'conclusion', equals: 'failure' }]
    }], { onMetrics: metrics });

    expect(result).toHaveLength(2);
    expect(metrics).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      requestCount: 1,
      recordsScanned: 2,
      recordsReturned: 2,
      index: 'byConclusion'
    });
    expect(metrics).toHaveBeenCalledTimes(1);
  });

  it('uses run indexes without changing filtered collection order', async () => {
    const records = [
      { id: 'event:1', runId: 'run:1', type: 'tool.call' },
      { id: 'event:2', runId: 'run:2', type: 'tool.call' },
      { id: 'event:3', runId: 'run:1', type: 'tool.result' },
      { id: 'event:4', runId: 'run:1', type: 'tool.call' }
    ];
    const operators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([{
      op: 'filter',
      predicates: [
        { field: 'runId', equals: 'run:1' },
        { field: 'type', equals: 'tool.call' }
      ]
    }]);
    await writeRecords('tools', records);
    const stored = await readCollection(indexedDB, 'tools');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'tools', operators);

    expect(result).toEqual(tidy(stored, operators));
    expect(indexedReads).toHaveBeenCalledTimes(1);
    indexedReads.mockRestore();
  });

  it('falls back to JavaScript for predicates IndexedDB cannot represent', async () => {
    const records = [
      { id: 'event:1', type: 'github-api.request' },
      { id: 'event:2', type: 'tool.call' }
    ];
    const operators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([{
      op: 'filter',
      predicates: [{ field: 'type', includes: 'github-api.' }]
    }]);
    await writeRecords('audits', records);
    const stored = await readCollection(indexedDB, 'audits');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'audits', operators);

    expect(result).toEqual(tidy(stored, operators));
    expect(indexedReads).not.toHaveBeenCalled();
    indexedReads.mockRestore();
  });

  it('falls back when JavaScript sentinel semantics are broader than IndexedDB keys', async () => {
    const records = [
      { id: 'run:1', conclusion: null },
      { id: 'run:2', conclusion: 'unknown' },
      { id: 'run:3', conclusion: 'success' }
    ];
    const operators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([{
      op: 'filter',
      predicates: [{ field: 'conclusion', equals: 'unknown' }]
    }]);
    await writeRecords('runs', records);
    const stored = await readCollection(indexedDB, 'runs');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'runs', operators);

    expect(result).toEqual(tidy(stored, operators));
    expect(result).toHaveLength(2);
    expect(indexedReads).not.toHaveBeenCalled();
    indexedReads.mockRestore();
  });

  it('bounds index lookups without changing query results', async () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      id: `run:${String(index).padStart(2, '0')}`,
      conclusion: `conclusion:${String(index).padStart(2, '0')}`
    }));
    await writeRecords('runs', records);
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');
    const storeReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const indexedOperators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([{
      op: 'filter',
      predicates: [{ field: 'conclusion', in: records.slice(0, 32).map(({ conclusion }) => conclusion) }]
    }]);
    const scanOperators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([{
      op: 'filter',
      predicates: [{ field: 'conclusion', in: records.slice(0, 33).map(({ conclusion }) => conclusion) }]
    }]);

    expect(await queryCollection(indexedDB, 'runs', indexedOperators))
      .toEqual(tidy(records, indexedOperators));
    expect(indexedReads).toHaveBeenCalledTimes(32);
    expect(await queryCollection(indexedDB, 'runs', scanOperators))
      .toEqual(tidy(records, scanOperators));
    expect(storeReads).toHaveBeenCalledTimes(1);
    indexedReads.mockRestore();
    storeReads.mockRestore();
  });

  it('writes 100,000 records in bounded transactions', async () => {
    const canonicalBatch = normalize([]);
    canonicalBatch.repositories = Array.from({ length: 100_000 }, (_, index) => ({
      id: `repository:${index}`
    }));
    /** @type {{ committedBatches: number, committedRecords: number }[]} */
    const progress = [];

    const result = await upsertCanonicalBatch(indexedDB, canonicalBatch, {
      batchSize: 5_000,
      onBatchCommitted: (value) => {
        progress.push(value);
      }
    });

    expect(progress).toHaveLength(20);
    expect(progress.at(-1)).toEqual({ committedBatches: 20, committedRecords: 100_000 });
    expect(result).toEqual({ committedBatches: 20, committedRecords: 100_000 });
  }, 45_000);

  it('replaces retained records in bounded writes and reports storage progress', async () => {
    const replacement = normalize(Array.from({ length: 2_500 }, (_, index) => ({
      kind: /** @type {const} */ ('repository'),
      source: 'fixture',
      sourceId: `repo-${index}`,
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: `repository:${index}`, fullName: `githubnext/repo-${index}` }
    })));
    await upsertCanonicalBatch(indexedDB, batch());
    /** @type {{ storedRecords: number, totalRecords: number }[]} */
    const progress = [];

    await replaceCanonicalBatch(indexedDB, replacement, {
      batchSize: 1_000,
      onProgress: (written) => progress.push(written)
    });

    expect(progress.map((entry) => entry.storedRecords)).toEqual([1_000, 2_000, 2_500]);
    expect(progress.every((entry) => entry.totalRecords === 2_500)).toBe(true);
    const stored = await readCollection(indexedDB, 'repositories');
    expect(stored).toHaveLength(2_500);
    expect(await readRecord(indexedDB, 'repositories', 'repository:1'))
      .toEqual(expect.objectContaining({ fullName: 'githubnext/repo-1' }));
  });

  it('does not rewrite structurally unchanged retained records', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    /** @type {{ storedRecords: number, totalRecords: number }[]} */
    const progress = [];

    await replaceCanonicalBatch(indexedDB, structuredClone(canonicalBatch), {
      previousBatch: structuredClone(canonicalBatch),
      onProgress: (written) => progress.push(written)
    });

    expect(progress).toEqual([{ storedRecords: 0, totalRecords: 0 }]);
    expect(await readCollection(indexedDB, 'repositories')).toEqual(canonicalBatch.repositories);
  });

  it('uses the supplied snapshot for bounded reconciliation without scanning database keys', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    const keyScans = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
    const metrics = vi.fn();

    await replaceCanonicalBatch(indexedDB, normalize([]), {
      previousBatch: canonicalBatch,
      onMetrics: metrics
    });

    expect(keyScans).not.toHaveBeenCalled();
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      deletedRecords: 1,
      scannedKeys: 0
    }));
    keyScans.mockRestore();
  });

  it('uses key-only cursors when reconciliation has no previous snapshot', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    const keyScans = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
    const cursors = vi.spyOn(IDBObjectStore.prototype, 'openKeyCursor');

    await replaceCanonicalBatch(indexedDB, normalize([]));

    expect(keyScans).not.toHaveBeenCalled();
    expect(cursors).toHaveBeenCalled();
    keyScans.mockRestore();
    cursors.mockRestore();
  });

  it('falls back to materialized keys when key-only cursors are unavailable', async () => {
    const canonicalBatch = batch();
    canonicalBatch.repositories.push({ id: 'repository:2', fullName: 'githubnext/other' });
    await upsertCanonicalBatch(indexedDB, canonicalBatch);
    const originalOpenKeyCursor = IDBObjectStore.prototype.openKeyCursor;
    const keyScans = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
    const metrics = vi.fn();
    IDBObjectStore.prototype.openKeyCursor = /** @type {typeof IDBObjectStore.prototype.openKeyCursor} */ (
      /** @type {unknown} */ (undefined)
    );

    try {
      await replaceCanonicalBatch(indexedDB, normalize([]), { onMetrics: metrics });
    } finally {
      IDBObjectStore.prototype.openKeyCursor = originalOpenKeyCursor;
    }

    expect(keyScans).toHaveBeenCalled();
    expect(metrics).toHaveBeenCalledTimes(1);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      deletedRecords: 2,
      scannedKeys: 2
    }));
    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
    keyScans.mockRestore();
  });

  it('converges after a partial write failure is retried', async () => {
    const replacement = normalize([]);
    replacement.repositories = [
      { id: 'repository:1', fullName: 'githubnext/one' },
      { id: 'repository:2', fullName: 'githubnext/two' }
    ];
    const originalPut = IDBObjectStore.prototype.put;
    const metrics = vi.fn();
    let puts = 0;
    IDBObjectStore.prototype.put = function failingSecondPut(/** @type {unknown} */ value) {
      puts += 1;
      if (puts === 2) throw new DOMException('simulated write failure', 'AbortError');
      return originalPut.call(this, value);
    };

    try {
      await expect(replaceCanonicalBatch(indexedDB, replacement, {
        batchSize: 1,
        onMetrics: metrics
      }))
        .rejects.toThrow('simulated write failure');
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ abortedTransactions: 1 }));
    expect(metrics).toHaveBeenCalledTimes(1);
    await expect(replaceCanonicalBatch(indexedDB, replacement, { batchSize: 1 }))
      .resolves.toBeUndefined();
    expect(await readCollection(indexedDB, 'repositories')).toEqual(replacement.repositories);
  });

  it('preserves the original write error when transaction abort also fails', async () => {
    const replacement = normalize([]);
    replacement.repositories = [{ id: 'repository:1' }];
    const originalPut = IDBObjectStore.prototype.put;
    const originalAbort = IDBTransaction.prototype.abort;
    const metrics = vi.fn();
    IDBObjectStore.prototype.put = function failingPut() {
      throw new DOMException('simulated write failure', 'DataCloneError');
    };
    IDBTransaction.prototype.abort = function failingAbort() {
      throw new DOMException('simulated abort failure', 'InvalidStateError');
    };

    try {
      await expect(replaceCanonicalBatch(indexedDB, replacement, { onMetrics: metrics }))
        .rejects.toThrow('simulated write failure');
    } finally {
      IDBObjectStore.prototype.put = originalPut;
      IDBTransaction.prototype.abort = originalAbort;
    }

    expect(metrics).toHaveBeenCalledTimes(1);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ abortedTransactions: 1 }));
  });

  it('evicts records omitted from a supplied previous snapshot', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);

    await replaceCanonicalBatch(indexedDB, normalize([]), {
      previousBatch: canonicalBatch
    });

    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
  });

  it('reconciles large mixed changes without scanning stored keys', async () => {
    const previous = normalize([]);
    previous.repositories = Array.from({ length: 20_000 }, (_, index) => ({
      id: `repository:${index}`,
      revision: 1
    }));
    await upsertCanonicalBatch(indexedDB, previous, { batchSize: 5_000 });
    const replacement = normalize([]);
    replacement.repositories = [
      ...previous.repositories.slice(0, 5_000),
      ...previous.repositories.slice(5_000, 10_000).map((record) => ({ ...record, revision: 2 })),
      ...Array.from({ length: 10_000 }, (_, index) => ({
        id: `repository:${20_000 + index}`,
        revision: 1
      }))
    ];
    const keyCursors = vi.spyOn(IDBObjectStore.prototype, 'openKeyCursor');
    const keyScans = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
    const metrics = vi.fn();

    await replaceCanonicalBatch(indexedDB, replacement, {
      batchSize: 5_000,
      previousBatch: previous,
      onMetrics: metrics
    });

    expect(keyCursors).not.toHaveBeenCalled();
    expect(keyScans).not.toHaveBeenCalled();
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      storedRecords: 15_000,
      deletedRecords: 10_000,
      scannedKeys: 0,
      requestCount: 25_000,
      abortedTransactions: 0
    }));
    const stored = await readCollection(indexedDB, 'repositories');
    expect(stored).toHaveLength(20_000);
    expect(stored.find(({ id }) => id === 'repository:5000')).toMatchObject({ revision: 2 });
    expect(stored.some(({ id }) => id === 'repository:10000')).toBe(false);
    expect(stored.some(({ id }) => id === 'repository:29999')).toBe(true);
    keyCursors.mockRestore();
    keyScans.mockRestore();
  }, 45_000);

  it('keeps only the newest 1,000 ingestion transactions', async () => {
    const existing = Array.from({ length: 1_000 }, (_, index) => ({
      id: `transaction:${String(index).padStart(4, '0')}`,
      kind: 'fixture',
      createdAt: new Date(index).toISOString()
    }));
    await writeRecords('transactions', existing);

    await recordTransaction(indexedDB, {
      id: 'transaction:latest',
      kind: 'fixture',
      createdAt: new Date(1_000).toISOString()
    });

    const transactions = await readTransactions(indexedDB);
    expect(transactions).toHaveLength(1_000);
    expect(transactions.some(({ id }) => id === 'transaction:0000')).toBe(false);
    expect(transactions.some(({ id }) => id === 'transaction:latest')).toBe(true);
  });

  it('validates relationships before changing stored records', async () => {
    await upsertCanonicalBatch(indexedDB, batch());
    const invalid = normalize([]);
    invalid.workflows.push({
      id: 'workflow:missing-parent',
      repositoryId: 'repository:missing'
    });

    await expect(upsertCanonicalBatch(indexedDB, invalid))
      .rejects.toThrow('Canonical relationship validation failed');
    expect(await readCollection(indexedDB, 'repositories')).toHaveLength(1);
    expect(await readCollection(indexedDB, 'workflows')).toEqual([]);
  });

  it('deletes the canonical database when no connections remain open', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    database.close();

    await expect(deleteCanonicalDatabase(indexedDB)).resolves.toBeUndefined();
    const databases = await indexedDB.databases();
    expect(databases.some(({ name }) => name === DATABASE_NAME)).toBe(false);
  });

  it('resolves the delete once a blocking connection closes within the grace period', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    const onBlocked = () => setTimeout(() => database.close(), 10);

    await expect(deleteCanonicalDatabase(indexedDB, { onBlocked })).resolves.toBeUndefined();
  });

  it('closes stale connections when another context deletes the database', async () => {
    const database = await openCanonicalDatabase(indexedDB);

    await expect(deleteCanonicalDatabase(indexedDB, { blockedTimeoutMs: 20 }))
      .resolves.toBeUndefined();
    database.close();
  });

  it('does not leak an open connection when acquiring the ingestion lock fails', async () => {
    const failure = new Error('lock acquisition failed');
    const originalTransaction = IDBDatabase.prototype.transaction;
    let attempted = false;
    IDBDatabase.prototype.transaction = /** @type {typeof IDBDatabase.prototype.transaction} */ (
      function patchedTransaction(/** @type {string | string[]} */ storeNames, /** @type {IDBTransactionMode} */ mode) {
        if (!attempted && storeNames === 'transactions') {
          attempted = true;
          throw failure;
        }
        return originalTransaction.call(this, storeNames, mode);
      }
    );

    try {
      await expect(withCanonicalIngestionLock(indexedDB, async () => 'unreachable', { locks: null }))
        .rejects.toThrow('lock acquisition failed');
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }

    // A leaked connection from the failed acquisition attempt would block
    // this delete; it must resolve promptly if the connection was closed.
    await expect(deleteCanonicalDatabase(indexedDB, { blockedTimeoutMs: 200 })).resolves.toBeUndefined();
  });

  it('replaces malformed ingestion lock records instead of waiting forever', async () => {
    await writeTransactionRecord({
      id: 'lock:canonical-ingestion',
      kind: 'canonical-ingestion-lock',
      createdAt: new Date().toISOString(),
      owner: 'safari-stale-tab',
      expiresAt: 'not-a-number'
    });

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'recovered', { locks: null }))
      .resolves.toBe('recovered');
  });

  it('replaces impossible future ingestion lock leases instead of waiting forever', async () => {
    await writeTransactionRecord({
      id: 'lock:canonical-ingestion',
      kind: 'canonical-ingestion-lock',
      createdAt: new Date().toISOString(),
      owner: 'safari-stale-tab',
      expiresAt: Date.now() + (60 * 60 * 1000)
    });

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'recovered', { locks: null }))
      .resolves.toBe('recovered');
  });

  it('times out instead of waiting forever for an active ingestion lock', async () => {
    await writeTransactionRecord({
      id: 'lock:canonical-ingestion',
      kind: 'canonical-ingestion-lock',
      createdAt: new Date().toISOString(),
      owner: 'active-tab',
      expiresAt: Date.now() + 30_000
    });

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'unreachable', {
      locks: null,
      acquireTimeoutMs: 20,
      retryDelayMs: 1
    })).rejects.toMatchObject({ name: 'CanonicalIngestionLockTimeoutError' });
  });

  it('reports waiting while a leased ingestion lock is still active', async () => {
    let waiting = 0;
    await writeTransactionRecord({
      id: 'lock:canonical-ingestion',
      kind: 'canonical-ingestion-lock',
      createdAt: new Date().toISOString(),
      owner: 'active-tab',
      expiresAt: Date.now() + 30_000
    });

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'unreachable', {
      locks: null,
      acquireTimeoutMs: 60,
      retryDelayMs: 1,
      waitingNoticeDelayMs: 1,
      onWaiting: () => { waiting += 1; }
    })).rejects.toMatchObject({ name: 'CanonicalIngestionLockTimeoutError' });
    expect(waiting).toBe(1);
  });

  it('ignores a lease abandoned by a terminated tab when Web Locks are available', async () => {
    await writeTransactionRecord({
      id: 'lock:canonical-ingestion',
      kind: 'canonical-ingestion-lock',
      createdAt: new Date().toISOString(),
      owner: 'terminated-tab',
      expiresAt: Date.now() + (4 * 60 * 1000)
    });

    // The browser releases a Web Lock when its holder goes away, so ingestion
    // must not stall behind the record the terminated holder left behind.
    await expect(withCanonicalIngestionLock(indexedDB, async () => 'ingested', {
      acquireTimeoutMs: 200
    })).resolves.toBe('ingested');
  });

  it('serializes concurrent ingestion through the Web Lock', async () => {
    /** @type {string[]} */
    const order = [];
    /** @param {string} name */
    const ingest = (name) => withCanonicalIngestionLock(indexedDB, async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      order.push(`${name}:end`);
    });

    await Promise.all([ingest('first'), ingest('second')]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('reports waiting while another holder owns the Web Lock', async () => {
    let waiting = 0;
    let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    const holder = navigator.locks.request(
      `canonical-ingestion:${canonicalDatabaseName()}`,
      () => held
    );

    const timedOut = withCanonicalIngestionLock(indexedDB, async () => 'unreachable', {
      acquireTimeoutMs: 50,
      waitingNoticeDelayMs: 1,
      onWaiting: () => { waiting += 1; }
    });

    await expect(timedOut).rejects.toMatchObject({ name: 'CanonicalIngestionLockTimeoutError' });
    expect(waiting).toBe(1);
    release();
    await holder;
  });
});

describe('daily overview aggregates', () => {
  /** @param {string} day @param {Partial<Record<string, number>>} [overrides] */
  function dailyAggregate(day, overrides = {}) {
    return {
      day,
      runs: 10,
      successfulRuns: 8,
      failedRuns: 2,
      dispatches: 4,
      failedDispatches: 1,
      ...overrides
    };
  }

  it('fails closed when no generation has ever been published', async () => {
    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result).toMatchObject({
      available: false,
      fallbackReason: 'metadata-missing',
      generation: null,
      records: []
    });
  });

  it('publishes a generation and range-reads only the requested days', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      builtAt: '2026-09-21T00:00:00Z',
      dailyAggregates: [
        dailyAggregate('2026-09-10'),
        dailyAggregate('2026-09-11'),
        dailyAggregate('2026-09-12')
      ]
    });

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-10', endDay: '2026-09-11' });

    expect(result.available).toBe(true);
    expect(result.generation).toBe('generation-a');
    expect(result.records.map((record) => record.day)).toEqual(['2026-09-10', '2026-09-11']);
    expect(result.recordsReturned).toBe(2);
  });

  it('resolves the active generation via a compound generation/day range index', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10')]
    });
    // A stale, unpublished generation with overlapping days must never leak
    // into a range read scoped to the active generation.
    await new Promise((resolve, reject) => {
      openCanonicalDatabase(indexedDB).then((database) => {
        const transaction = database.transaction('dailyOverviewAggregates', 'readwrite');
        transaction.objectStore('dailyOverviewAggregates').put({
          id: 'generation-b:2026-09-10',
          generation: 'generation-b',
          day: '2026-09-10',
          runs: 999,
          successfulRuns: 999,
          failedRuns: 0,
          dispatches: 0,
          failedDispatches: 0
        });
        transaction.oncomplete = () => { database.close(); resolve(undefined); };
        transaction.onerror = () => reject(transaction.error);
      });
    });

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ generation: 'generation-a', runs: 10 });
  });

  it('leaves the previous generation active and readable when publication is interrupted', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10', { runs: 5 })]
    });

    // Simulate a crash: generation-b's records are written directly to the
    // store (as publishDailyOverviewAggregates would, before it reaches the
    // metadata-publication step) without ever updating the metadata record.
    const database = await openCanonicalDatabase(indexedDB);
    const transaction = database.transaction('dailyOverviewAggregates', 'readwrite');
    transaction.objectStore('dailyOverviewAggregates').put({
      id: 'generation-b:2026-09-10',
      generation: 'generation-b',
      day: '2026-09-10',
      runs: 999,
      successfulRuns: 0,
      failedRuns: 0,
      dispatches: 0,
      failedDispatches: 0
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result.generation).toBe('generation-a');
    expect(result.records).toEqual([expect.objectContaining({ generation: 'generation-a', runs: 5 })]);
  });

  it('activates the new generation only after every record has committed', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10', { runs: 5 })]
    });

    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-b',
      dailyAggregates: [dailyAggregate('2026-09-10', { runs: 7 }), dailyAggregate('2026-09-11', { runs: 3 })]
    });

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result.generation).toBe('generation-b');
    expect(result.records.map((record) => record.runs).sort((a, b) => a - b)).toEqual([3, 7]);
  });

  it('falls back when the published metadata version does not match this build', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10')]
    });
    const database = await openCanonicalDatabase(indexedDB);
    const transaction = database.transaction('overviewAggregateMetadata', 'readwrite');
    const store = transaction.objectStore('overviewAggregateMetadata');
    const existing = await new Promise((resolve, reject) => {
      const request = store.get('daily-overview-aggregates');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    store.put({ ...existing, version: existing.version + 1 });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result).toMatchObject({ available: false, fallbackReason: 'version-mismatch' });
  });

  it('prunes stale generations without touching the active generation', async () => {
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10')]
    });
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-b',
      dailyAggregates: [dailyAggregate('2026-09-10'), dailyAggregate('2026-09-11')]
    });

    const { deletedRecords } = await pruneStaleDailyOverviewAggregates(indexedDB);
    expect(deletedRecords).toBe(1);

    const database = await openCanonicalDatabase(indexedDB);
    const remaining = await new Promise((resolve, reject) => {
      const request = database.transaction('dailyOverviewAggregates').objectStore('dailyOverviewAggregates').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    expect(remaining.every((/** @type {{ generation: string }} */ record) => record.generation === 'generation-b')).toBe(true);
    expect(remaining).toHaveLength(2);
  });

  it('writes generation records in bounded batches', async () => {
    const dailyAggregates = Array.from({ length: 5 }, (_, index) =>
      dailyAggregate(`2026-09-${String(10 + index).padStart(2, '0')}`));

    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates,
      batchSize: 2
    });

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });
    expect(result.recordsReturned).toBe(5);
  });
});
