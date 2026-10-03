import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDashboardSourceSync } from '../../../report/bundle-dashboards.mjs';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const dashboard = loadDashboardSourceSync(join(siteRoot, 'dashboard.json')).document.dashboard;
const queries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (
  dashboard?.queries ?? [])
  .filter((query) => [
    'audit-event-runs', 'domain-event-runs', 'tool-event-runs', 'issue-event-runs',
    'event-runs', 'audit-event-summary-buckets'
  ].includes(String(query.name)));
queries.push({
  name: 'opaque-tool-labels', from: 'mcp-calls',
  compute: [{
    as: 'opaque-label', function: 'concat',
    args: [{ field: 'mcp-server' }, { value: '/' }, { field: 'mcp-tool' }]
  }]
}, {
  name: 'opaque-tool-selection', from: 'opaque-tool-labels',
  filter: { predicates: [{ field: 'opaque-label', equals: 'server/with/slash/tool' }] },
  select: [{ field: 'mcp-observation' }, { field: 'opaque-label' }],
  'order-by': [{ field: 'mcp-observation', direction: 'asc' }]
});
const pageContext = {
  pages: dashboard?.pages?.filter((page) => page.id === 'tool-runs'),
  queries: dashboard?.queries?.filter((query) => query.name === 'mcp-tool-calls'),
  views: dashboard?.views
};

test('production worker counts event sources beyond input thresholds using native indexes', async ({ context, page }) => {
  test.setTimeout(180000);
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Indexed event aggregation test</main>' });
      return;
    }
    if (pathname === '/aggregate-worker.js') {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          const getAll = IDBObjectStore.prototype.getAll;
          IDBObjectStore.prototype.getAll = function(...args) {
            if (['tools', 'audits'].includes(this.name)) throw new Error('Event document materialization');
            return getAll.apply(this, args);
          };
          await import('/src/data-worker.js');
          self.postMessage({ ready: true });`
      });
      return;
    }
    const path = join(siteRoot, pathname);
    await route.fulfill(existsSync(path)
      ? { contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript', body: readFileSync(path) }
      : { status: 404, body: 'Not found' });
  });
  await page.goto('http://dashboard.test/');
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await page.evaluate(async ({ definitions, pageContext }) => {
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const storage = await import(storageUrl);
    const database = await storage.openCanonicalDatabase(indexedDB);
    const done = (/** @type {IDBTransaction} */ transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    const inventory = database.transaction(['campaigns', 'repositories', 'workflows', 'runs'], 'readwrite');
    inventory.objectStore('campaigns').put({ id: 'campaign:activity', slug: 'activity' });
    inventory.objectStore('repositories').put({ id: 'repo', owner: 'githubnext', name: 'gh-aw-cao' });
    inventory.objectStore('workflows').put({ id: 'workflow', repositoryId: 'repo', path: 'activity.md', campaignId: 'campaign:activity' });
    for (const attempt of [1, 2]) {
      inventory.objectStore('runs').put({
        id: `attempt-${attempt}`, owner: 'githubnext', repository: 'gh-aw-cao',
        workflowPath: 'activity.md', githubRunId: '42', attempt
      });
    }
    await done(inventory);
    const count = 200001;
    for (const storeName of ['tools', 'audits']) {
      for (let offset = 0; offset < count; offset += 5000) {
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        for (let position = offset; position < Math.min(count, offset + 5000); position += 1) {
          store.put(storage.prepareCanonicalRecord(storeName, {
            id: `${storeName}-${position}`, runId: `attempt-${position % 2 + 1}`,
            source: storeName === 'tools' ? 'mcp' : 'audit',
            type: storeName === 'tools' ? 'tool.call' : 'audit.finding',
            status: storeName === 'tools' ? 'success' : position % 3 === 0 ? 'medium' : 'high',
            ...(storeName === 'tools' ? {
              mcpServer: position === 0 ? 'server/with' : position === 1 ? 'server' : 'other',
              mcpTool: position === 0 ? 'slash/tool' : position === 1 ? 'with/slash/tool' : 'unused'
            } : {}),
            ...(position % 5 === 0 ? {} : { summary: `finding-${position % 4}` })
          }));
        }
        await done(transaction);
      }
    }
    database.close();
    const worker = new Worker('/aggregate-worker.js', { type: 'module' });
    try {
      const initial = /** @type {Record<string, unknown>} */ (await new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = (event) => {
          if (event.data.ready) {
            worker.postMessage({
              id: 1, operation: 'query-canonical-dashboard',
              sourceNames: ['tool-event-runs', 'event-runs', 'audit-event-summary-buckets', 'opaque-tool-selection'],
              context: { pages: [], queries: definitions }
            });
            return;
          }
          if (event.data.id !== 1) return;
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.data);
        };
      }));
      const pagePayload = /** @type {Record<string, unknown>} */ (await new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          if (event.data.id !== 2) return;
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.data);
        };
        worker.postMessage({
          id: 2, operation: 'query-canonical-dashboard',
          sourceNames: ['mcp-tool-calls'], pageId: 'tool-runs', viewId: 'tool-runs-table',
          routeParameters: { tool: 'server/with/slash/tool' }, context: pageContext
        });
      }));
      return { ...initial, ...pagePayload };
    } finally {
      worker.terminate();
    }
  }, { definitions: queries, pageContext }));
  for (const name of ['tool-event-runs', 'event-runs', 'audit-event-summary-buckets', 'opaque-tool-selection']) {
    expect(result[name].metadata.availability).toBe('available');
    expect(result[name].metadata['query-diagnostic']).toBeUndefined();
  }
  expect(result['tool-event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(200001);
  expect(result['event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(400002);
  expect(result['event-runs'].rows.map((row) => row['run-attempt']).sort()).toEqual([1, 2]);
  expect(result['audit-event-summary-buckets'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(200001);
  expect(result['audit-event-summary-buckets'].rows.every((row) => row.campaign === 'activity')).toBe(true);
  expect(result['opaque-tool-selection'].rows).toEqual([
    { 'mcp-observation': 'tools-0', 'opaque-label': 'server/with/slash/tool' },
    { 'mcp-observation': 'tools-1', 'opaque-label': 'server/with/slash/tool' }
  ]);
  const view = result['view:tool-runs:tool-runs-table:mcp-tool-calls'];
  expect(view.metadata.availability).toBe('available');
  expect(view.rows.map((row) => row['mcp-observation']).sort()).toEqual(['tools-0', 'tools-1']);
});
