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
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(filePath)
      });
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

test('production data worker preserves daily health and repository chart coverage after detail eviction', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/data/storage/indexeddb.js`);
    const { normalize } = await import(`${location.origin}/src/data/normalize/index.js`);
    const fragment = await (await fetch('/dashboard-fragments/workflow-runs.json')).json();
    const inventory = await (await fetch('/dashboard-fragments/inventory.json')).json();
    const repositories = await (await fetch('/dashboard-fragments/repositories.json')).json();
    const { compileDashboardViewPayloadQueries } = await import(`${location.origin}/src/data/queries/view-payload-compiler.js`);
    const repositoryPage = repositories.pages.find((/** @type {{ id: string }} */ value) => value.id === 'repositories');
    const query = fragment.queries.find((/** @type {{ name: string }} */ value) =>
      value.name === 'workflow-runtime-health-summary');
    const worker = new Worker(`${location.origin}/src/data-worker.js`, { type: 'module' });
    const repositoryPayload = compileDashboardViewPayloadQueries(repositoryPage.definition, 'repositories', {
      queries: [...inventory.queries, ...repositories.queries], viewId: 'repositories-runs',
      evaluatedAt: '2026-10-15T00:00:00Z'
    });
    const queryHealth = () => /** @type {Promise<Record<string, import('../../src/presenter.js').LogicalSourceInput>>} */ (new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        if (event.data.id !== 'daily-health') return;
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.data);
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({
        id: 'daily-health', operation: 'load-dashboard-query-sources',
        sources: {}, queries: [...inventory.queries, query, ...repositoryPayload.queries],
        sourceNames: ['workflow-runtime-health-summary', 'runs-daily-conclusions', ...repositoryPayload.aliases]
      });
    }));
    try {
      const run = {
        id: 'run:count', repositoryId: 'repository:count', workflowId: 'workflow:count',
        owner: 'octo', repository: 'demo', workflowPath: '.github/workflows/worker.md',
        startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
        status: 'in_progress', conclusion: null, attempt: 1
      };
      await storage.upsertCanonicalBatch(indexedDB, {
        ...normalize([]), runs: [run],
        repositories: [{ id: 'repository:count', owner: 'octo', name: 'demo' }]
      },
        { validateRelationships: false });
      const pending = await queryHealth();
      await storage.upsertCanonicalBatch(indexedDB, {
        ...normalize([]), runs: [{
          ...run, startedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z',
          status: 'completed', conclusion: 'failure'
        }]
      }, { validateRelationships: false });
      const maintenance = await storage.maintainCanonicalDatabase(indexedDB, {
        now: Date.parse('2026-10-15T00:00:00Z'), maxDatabaseBytes: 0
      });
      const corrected = await queryHealth();
      const detailCount = (await storage.readCollection(indexedDB, 'runs')).length;
      const daily = (await storage.readCollections(indexedDB, ['dailyRunCounts'])).dailyRunCounts;
      await storage.maintainCanonicalDatabase(indexedDB, {
        now: Date.parse('2026-10-26T00:00:00Z'), maxDatabaseBytes: 0
      });
      await storage.upsertCanonicalBatch(indexedDB, { ...normalize([]), runs: [run] },
        { validateRelationships: false });
      const rolled = await queryHealth();
      const database = await storage.openCanonicalDatabase(indexedDB);
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('dailyRunCountState', 'readwrite');
        transaction.objectStore('dailyRunCountState').clear();
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      const unavailable = await queryHealth();
      return {
        pending, corrected, maintenance, detailCount, daily, rolled, unavailable,
        repositoryAlias: repositoryPayload.aliases[0],
        receipts: (await storage.readCollections(indexedDB, ['runCountContributions'])).runCountContributions.length
      };
    } finally {
      worker.terminate();
    }
  });
  expect(Object.keys(result.corrected).sort()).toEqual([result.repositoryAlias, 'runs-daily-conclusions', 'workflow-runtime-health-summary'].sort());
  for (const source of [result.pending, result.corrected]) {
    expect(source[result.repositoryAlias].rows).toEqual([
      expect.objectContaining({ repository: 'octo/demo', runs: 1 })
    ]);
    expect(source[result.repositoryAlias].metadata).toMatchObject({
      'aggregate-version': 1, 'aggregate-coverage': 'admitted'
    });
  }
  expect(result.rolled[result.repositoryAlias].rows).toEqual([
    expect.objectContaining({ repository: 'octo/demo', runs: 0 })
  ]);
  expect(result.rolled[result.repositoryAlias].metadata['aggregate-retention-start']).toBe('2026-10-12');
  expect(result.unavailable[result.repositoryAlias].rows).toEqual([]);
  expect(result.unavailable[result.repositoryAlias].metadata).toMatchObject({
    availability: 'unavailable', 'aggregate-version': 1, 'aggregate-coverage': 'absent'
  });
  expect(result.rolled['workflow-runtime-health-summary'].rows).toEqual([]);
  expect(result.rolled['runs-daily-conclusions'].rows).toEqual([]);
  expect(result.rolled['workflow-runtime-health-summary'].metadata['aggregate-retention-start']).toBe('2026-10-12');
  expect(result.receipts).toBe(0);
  expect(result.pending['workflow-runtime-health-summary'].rows).toEqual([expect.objectContaining({ total: 1, pending: 1, failed: 0 })]);
  expect(result.corrected['workflow-runtime-health-summary'].rows).toEqual([expect.objectContaining({ total: 1, pending: 0, failed: 1 })]);
  expect(result.corrected['workflow-runtime-health-summary'].metadata).toMatchObject({
    'aggregate-version': 1, 'aggregate-coverage': 'admitted', completeness: 'complete'
  });
  for (const [source, day, pending, failed] of [
    [result.pending, '2026-10-01', 1, 0],
    [result.corrected, '2026-10-02', 0, 1]
  ]) {
    const chart = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (source)['runs-daily-conclusions'];
    expect(chart.rows).toEqual([
      { day, 'runtime-health': 'Approval required', runs: 0 },
      { day, 'runtime-health': 'Failed', runs: failed },
      { day, 'runtime-health': 'Other', runs: 0 },
      { day, 'runtime-health': 'Pending', runs: pending },
      { day, 'runtime-health': 'Successful', runs: 0 }
    ]);
    expect(chart.metadata).toMatchObject({
      'aggregate-version': 1, 'aggregate-coverage': 'admitted', completeness: 'complete'
    });
  }
  expect(result.daily).toEqual([expect.objectContaining({ day: '2026-10-02', total: 1, failed: 1 })]);
  expect(result.detailCount).toBe(0);
  expect(result.maintenance.protectedBytes).toBeGreaterThan(0);
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

test('native retention compacts resolved logs across bounded pages and keeps replay compact', async ({ page }) => {
  const measured = await page.evaluate(async () => {
    const storage = await import(`${location.origin}/src/data/storage/indexeddb.js`);
    const batch = {
      repositories: [{ id: 'repo:1', owner: 'octo', name: 'control' }],
      workflows: [{ id: 'workflow:1', repositoryId: 'repo:1', role: 'orchestrator' }],
      runs: Array.from({ length: 1007 }, (_, index) => ({
        id: `github:run:octo/control:${index + 1}`, githubRunId: index + 1, attempt: 1,
        repositoryId: 'repo:1', workflowId: 'workflow:1', event: 'push', branch: 'main',
        startedAt: '2026-10-20T12:00:00Z', status: 'completed',
        conclusion: index === 1005 ? 'success' : 'failure',
        ...(index === 1005 ? {} : { failureLog: 'diagnostic '.repeat(200) })
      }))
    };
    await storage.upsertCanonicalBatch(indexedDB, batch);
    const original = IDBObjectStore.prototype.getAll;
    /** @type {(number | undefined)[]} */
    const reads = [];
    IDBObjectStore.prototype.getAll = function (
      /** @type {IDBValidKey | IDBKeyRange | null | undefined} */ query,
      /** @type {number | undefined} */ count
    ) {
      if (this.name === 'runs') reads.push(count);
      return original.call(this, query, count);
    };
    const options = { now: Date.parse('2026-10-20T13:00:00Z'), maxDatabaseBytes: Number.MAX_SAFE_INTEGER };
    try {
      const startedAt = performance.now();
      const first = await storage.maintainCanonicalDatabase(indexedDB, options);
      const durationMs = performance.now() - startedAt;
      await storage.upsertCanonicalBatch(indexedDB, batch);
      const replayed = await storage.maintainCanonicalDatabase(indexedDB, options);
      IDBObjectStore.prototype.getAll = original;
      const runs = await storage.readCollection(indexedDB, 'runs');
      return {
        first, replayed, durationMs, reads, runCount: runs.length,
        logs: runs.filter((/** @type {Record<string, unknown>} */ run) => run.failureLog)
          .map((/** @type {Record<string, unknown>} */ run) => run.githubRunId)
      };
    } finally {
      IDBObjectStore.prototype.getAll = original;
    }
  });
  expect(measured.first).toMatchObject({ deletedRecords: 0, prunedFailureLogs: 1005 });
  expect(measured.replayed).toMatchObject({ deletedRecords: 0, prunedFailureLogs: 0 });
  expect(measured.first.estimatedBytes).toBe(measured.replayed.estimatedBytes);
  expect(measured.reads.length).toBeGreaterThan(2);
  expect(measured.reads.every((count) => count === 1000)).toBe(true);
  expect(measured.runCount).toBe(1007);
  expect(measured.logs).toEqual([1007]);
  console.log(`Native failure-log retention: ${Math.round(measured.durationMs)}ms for 1007 Runs`);
});
