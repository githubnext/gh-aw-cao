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
