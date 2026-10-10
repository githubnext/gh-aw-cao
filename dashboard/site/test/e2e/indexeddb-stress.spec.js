import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const databaseName = 'gh-aw-cao-dashboard-data';

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<main>IndexedDB stress test</main>' });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({ contentType: 'application/javascript', body: readFileSync(filePath) });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto('http://dashboard.test/');
  await page.evaluate((name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  }), databaseName);
});

test('native IndexedDB persists a large mixed reconciliation across connections', async ({ page }) => {
  test.slow();
  const result = await page.evaluate(async () => {
    const normalizeUrl = `${location.origin}/src/data/normalize/index.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ normalize }, storage] = await Promise.all([
      import(normalizeUrl),
      import(storageUrl)
    ]);
    const previous = normalize([]);
    previous.repositories = Array.from({ length: 12_000 }, (_, index) => ({
      id: `repository:${index}`,
      revision: 1
    }));
    await storage.upsertCanonicalBatch(indexedDB, previous, { batchSize: 2_000 });
    const replacement = normalize([]);
    replacement.repositories = [
      ...previous.repositories.slice(0, 3_000),
      ...previous.repositories.slice(3_000, 6_000)
        .map((/** @type {Record<string, unknown>} */ record) => ({ ...record, revision: 2 })),
      ...Array.from({ length: 6_000 }, (_, index) => ({
        id: `repository:${12_000 + index}`,
        revision: 1
      }))
    ];
    /** @type {Record<string, number> | undefined} */
    let metrics;
    await storage.replaceCanonicalBatch(indexedDB, replacement, {
      batchSize: 2_000,
      previousBatch: previous,
      onMetrics: (/** @type {Record<string, number>} */ value) => { metrics = value; }
    });

    const reopened = await storage.openCanonicalDatabase(indexedDB);
    reopened.close();
    const stored = /** @type {Record<string, unknown>[]} */ (
      await storage.readCollection(indexedDB, 'repositories')
    );
    return {
      metrics,
      count: stored.length,
      changedRevision: stored.find(({ id }) => id === 'repository:3000')?.revision,
      removedPresent: stored.some(({ id }) => id === 'repository:6000'),
      addedPresent: stored.some(({ id }) => id === 'repository:17999')
    };
  });

  expect(result).toEqual({
    metrics: expect.objectContaining({
      storedRecords: 9_000,
      deletedRecords: 6_000,
      scannedKeys: 0,
      requestCount: 15_000,
      abortedTransactions: 0
    }),
    count: 12_000,
    changedRevision: 2,
    removedPresent: false,
    addedPresent: true
  });
});

test('native retention cleans expired shards without scanning retained entities', async ({ page }) => {
  const measured = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/data/storage/indexeddb.js`);
    const { normalize } = await import(`${location.origin}/src/data/normalize/index.js`);
    const batch = normalize([]);
    batch.runs = [{ id: 'run:1', startedAt: '2026-01-01T00:00:00Z' }];
    batch.tools = Array.from({ length: 25_000 }, (_, index) => ({
      id: `tool:${String(index).padStart(6, '0')}`, runId: 'run:1', summary: 'github.list_issues',
      timestamp: index < 5000 ? '2026-10-01T00:00:00Z' : '2026-10-09T00:00:00Z'
    }));
    await storage.upsertCanonicalBatch(indexedDB, batch, { validateRelationships: false });
    const original = IDBIndex.prototype.getAll;
    /** @type {{ index: string, count?: number, ranged: boolean }[]} */
    const reads = [];
    IDBIndex.prototype.getAll = function (
      /** @type {IDBValidKey | IDBKeyRange | null | undefined} */ query,
      /** @type {number | undefined} */ count
    ) {
      reads.push({ index: this.name, count, ranged: query instanceof IDBKeyRange });
      return original.call(this, query, count);
    };
    const options = {
      now: Date.parse('2026-10-10T12:00:00Z'), maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    };
    try {
      const start = performance.now();
      const first = await storage.maintainCanonicalDatabase(indexedDB, options);
      const cleanupMs = performance.now() - start;
      const cleanupReads = reads.splice(0);
      const repeatStart = performance.now();
      const repeated = await storage.maintainCanonicalDatabase(indexedDB, options);
      return {
        first, repeated, cleanupMs, repeatedMs: performance.now() - repeatStart,
        cleanupReads, repeatedReads: reads,
        counts: await storage.countCollections(indexedDB, ['runs', 'tools'])
      };
    } finally {
      IDBIndex.prototype.getAll = original;
    }
  });
  expect(measured.first).toMatchObject({ deletedRecords: 5000, retainedRecords: 20_001 });
  expect(measured.repeated).toMatchObject({ deletedRecords: 0, retainedRecords: 20_001 });
  expect(measured.cleanupReads.every(({ count, ranged }) => count === 1000 && ranged)).toBe(true);
  expect(measured.repeatedReads).toEqual([]);
  expect(measured.counts).toEqual({ runs: 1, tools: 20_000 });
  expect(measured.cleanupMs).toBeLessThan(10_000);
  expect(measured.repeatedMs).toBeLessThan(1000);
  console.log(`Native shard retention: ${Math.round(measured.cleanupMs)}ms cleanup; ${Math.round(measured.repeatedMs)}ms unchanged`);
});
