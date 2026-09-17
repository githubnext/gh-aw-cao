import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalDatabaseName,
  DATABASE_NAME,
  deleteCanonicalDatabase,
  openCanonicalDatabase,
  queryCollection,
  readCollection,
  readRecord,
  replaceCanonicalBatch,
  upsertCanonicalBatch,
  withCanonicalIngestionLock
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';
import { tidy } from '../../src/data-operations.js';

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

describe('canonical IndexedDB', () => {
  it('initializes the simplified database schema', async () => {
    const database = await openCanonicalDatabase(indexedDB);

    expect([...database.objectStoreNames]).toEqual([
      'events',
      'packages',
      'repositories',
      'runs',
      'transactions',
      'workflows'
    ]);
    expect(database.transaction('repositories').objectStore('repositories').keyPath).toBe('id');
    expect(database.transaction('runs').objectStore('runs').indexNames).toContain('byConclusion');
    expect(database.transaction('events').objectStore('events').indexNames).toContain('byRunType');
    database.close();
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

    expect([...database.objectStoreNames]).toEqual([
      'events',
      'packages',
      'repositories',
      'runs',
      'transactions',
      'workflows'
    ]);
    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
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

  it('uses compound indexes without changing filtered collection order', async () => {
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
    await writeRecords('events', records);
    const stored = await readCollection(indexedDB, 'events');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'events', operators);

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
    await writeRecords('events', records);
    const stored = await readCollection(indexedDB, 'events');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryCollection(indexedDB, 'events', operators);

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

  it('evicts records omitted from a supplied previous snapshot', async () => {
    const canonicalBatch = batch();
    await upsertCanonicalBatch(indexedDB, canonicalBatch);

    await replaceCanonicalBatch(indexedDB, normalize([]), {
      previousBatch: canonicalBatch
    });

    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
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

  it('rejects the delete if a blocking connection never closes', async () => {
    const database = await openCanonicalDatabase(indexedDB);

    await expect(deleteCanonicalDatabase(indexedDB, { blockedTimeoutMs: 20 }))
      .rejects.toThrow('blocked');
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
