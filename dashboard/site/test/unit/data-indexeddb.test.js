import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  openCanonicalDatabase,
  readCollection,
  readRecord,
  replaceCanonicalBatch,
  upsertCanonicalBatch,
  withCanonicalIngestionLock
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';

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
      'jobs',
      'packages',
      'repositories',
      'runs',
      'sessions',
      'transactions',
      'workflows'
    ]);
    expect(database.transaction('repositories').objectStore('repositories').keyPath).toBe('id');
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
      'jobs',
      'packages',
      'repositories',
      'runs',
      'sessions',
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
      await expect(withCanonicalIngestionLock(indexedDB, async () => 'unreachable'))
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

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'recovered'))
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

    await expect(withCanonicalIngestionLock(indexedDB, async () => 'recovered'))
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
      acquireTimeoutMs: 20,
      retryDelayMs: 1
    })).rejects.toMatchObject({ name: 'CanonicalIngestionLockTimeoutError' });
  });
});
