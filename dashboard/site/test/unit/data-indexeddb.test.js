import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  openCanonicalDatabase,
  readCollection,
  readRecord,
  replaceCanonicalBatch,
  upsertCanonicalBatch
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
      'meta',
      'packages',
      'repositories',
      'runs',
      'sessions',
      'staging-events',
      'staging-jobs',
      'staging-packages',
      'staging-repositories',
      'staging-runs',
      'staging-sessions',
      'staging-workflows',
      'transactions',
      'workflows'
    ]);
    expect(database.transaction('repositories').objectStore('repositories').keyPath).toBe('id');
    expect([...database.transaction('repositories').objectStore('repositories').indexNames]).toEqual([]);
    expect([...database.transaction('runs').objectStore('runs').indexNames]).toEqual([
      'byConclusionStartedAt',
      'byRepository',
      'byWorkflow'
    ]);
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
      'meta',
      'packages',
      'repositories',
      'runs',
      'sessions',
      'staging-events',
      'staging-jobs',
      'staging-packages',
      'staging-repositories',
      'staging-runs',
      'staging-sessions',
      'staging-workflows',
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

  it('skips unchanged stores during canonical replacement', async () => {
    const canonicalBatch = batch();
    const first = await replaceCanonicalBatch(indexedDB, canonicalBatch);
    const second = await replaceCanonicalBatch(indexedDB, canonicalBatch);

    expect(first).toMatchObject({ committedRecords: 1, skippedStores: 0 });
    expect(second).toEqual({ committedBatches: 0, committedRecords: 0, skippedStores: 7 });
    expect(await readCollection(indexedDB, 'repositories')).toHaveLength(1);
  });

  it('keeps the active generation visible when staging is interrupted', async () => {
    const activeBatch = batch();
    await replaceCanonicalBatch(indexedDB, activeBatch);
    const stagedBatch = normalize([
      {
        kind: 'repository',
        source: 'fixture',
        sourceId: 'repo-2',
        observedAt: '2026-09-09T06:00:00Z',
        data: { id: 'repository:2', fullName: 'githubnext/second' }
      }
    ]);

    await expect(replaceCanonicalBatch(indexedDB, stagedBatch, {
      onBatchCommitted: () => { throw new Error('interrupted staging'); }
    })).rejects.toThrow('interrupted staging');

    expect(await readCollection(indexedDB, 'repositories')).toEqual(activeBatch.repositories);
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
});
