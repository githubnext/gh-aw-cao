import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actualStorage = /** @type {typeof import('../../src/data/storage/indexeddb.js')} */ (
  await vi.importActual('../../src/data/storage/indexeddb.js')
);
const replaceCanonicalBatch = vi.fn(
  /** @type {(...parameters: unknown[]) => Promise<void>} */ (actualStorage.replaceCanonicalBatch)
);
vi.mock('../../src/data/storage/indexeddb.js', async () => ({
  ...actualStorage,
  replaceCanonicalBatch: (/** @type {unknown[]} */ ...parameters) => replaceCanonicalBatch(...parameters)
}));

const { ingestDashboardSources } = await import('../../src/data/ingest/coordinator.js');
const { DATABASE_NAME } = actualStorage;

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };

/** @param {number} count */
function sourcesWithRuns(count) {
  return {
    repositories: {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': metadata['as-of'] }],
      metadata
    },
    workflows: {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        'workflow-active': 'true',
        'observed-at': metadata['as-of']
      }],
      metadata
    },
    runs: {
      rows: Array.from({ length: count }, (_, index) => ({
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run: String(1000 + index),
        'run-attempt': 1,
        'run-status': 'completed',
        'run-conclusion': 'success',
        'started-at': new Date(Date.parse('2026-09-09T04:00:00Z') + index * 1000).toISOString(),
        'ended-at': metadata['as-of']
      })),
      metadata
    }
  };
}

/** @returns {Error} */
function quotaExceededError() {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

beforeEach(async () => {
  replaceCanonicalBatch.mockClear();
  replaceCanonicalBatch.mockImplementation(
    /** @type {(...parameters: unknown[]) => Promise<void>} */ (actualStorage.replaceCanonicalBatch)
  );
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical ingestion termination', () => {
  it('reports storage progress so long writes never look stalled', async () => {
    /** @type {{ storedRecords: number, totalRecords: number }[]} */
    const progress = [];

    await ingestDashboardSources(indexedDB, sourcesWithRuns(5), {
      onWriteProgress: (written) => progress.push(written)
    });

    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1);
    expect(last?.storedRecords).toBe(last?.totalRecords);
    expect(last?.totalRecords).toBe(7);
    expect(progress.map((entry) => entry.storedRecords))
      .toEqual([...progress.map((entry) => entry.storedRecords)].sort((left, right) => left - right));
  });

  it('stops retrying an exhausted quota after a bounded number of attempts', async () => {
    replaceCanonicalBatch.mockRejectedValue(quotaExceededError());

    await expect(ingestDashboardSources(indexedDB, sourcesWithRuns(64)))
      .rejects.toMatchObject({ name: 'CanonicalIngestionError', code: 'QUOTA_EXCEEDED' });
    expect(replaceCanonicalBatch.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('stops rewriting when reported database usage never drops below the cap', async () => {
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({
        usage: 4_000_000_000,
        quota: 8_000_000_000,
        usageDetails: { indexedDB: 4_000_000_000 }
      }),
      persist: vi.fn().mockResolvedValue(true)
    }));

    await expect(ingestDashboardSources(indexedDB, sourcesWithRuns(64), {
      storage,
      maxDatabaseBytes: 1_000_000
    })).resolves.toMatchObject({ updated: true });
    expect(replaceCanonicalBatch.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
