import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDashboardSourceSync } from '../../../report/bundle-dashboards.mjs';
import { canonicalToolMeasures } from '../tool-fixtures.js';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const dashboard = loadDashboardSourceSync(join(siteRoot, 'dashboard.json')).document.dashboard;
const queries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (
  dashboard?.queries ?? [])
  .filter((query) => [
    'audit-event-runs', 'domain-event-runs', 'tool-event-runs', 'issue-event-runs',
    'event-runs'
  ].includes(String(query.name)));
queries.push({
  name: 'indexed-audit-summary-buckets', from: 'audits',
  filter: { predicates: [
    { field: 'event-type', equals: 'audit.finding' },
    { field: 'event-status', in: ['high', 'medium'] }
  ] },
  joins: [{
    source: 'workflows', type: 'left',
    on: [
      { left: 'organization', right: 'organization' },
      { left: 'repository', right: 'repository' },
      { left: 'workflow', right: 'workflow' }
    ],
    fields: [{ field: 'campaign', as: 'campaign' }]
  }],
  aggregate: {
    by: ['campaign', 'event-status', 'workflow', 'event-summary'],
    values: [{ field: 'event', as: 'events', reducer: 'count' }]
  }
}, {
  name: 'opaque-tool-labels', from: 'mcp-calls',
  compute: [{
    as: 'opaque-label', function: 'concat',
    args: [{ field: 'mcp-server' }, { value: '/' }, { field: 'mcp-tool' }]
  }]
}, {
  name: 'opaque-tool-selection', from: 'opaque-tool-labels',
  filter: { predicates: [{ field: 'opaque-label', equals: 'server/with/slash/tool' }] },
  select: [{ field: 'tool-usage-id' }, { field: 'call-count' }, { field: 'run-attempt' }, { field: 'opaque-label' }],
  'order-by': [{ field: 'tool-usage-id', direction: 'asc' }]
});
const pageContext = {
  pages: dashboard?.pages?.filter((page) => page.id === 'tool-runs'),
  queries: dashboard?.queries?.filter((query) => query.name === 'mcp-tool-calls'),
  views: dashboard?.views
};

test('production worker counts indexed audit events and exact compact Tool measures beyond input thresholds', async ({ context, page }) => {
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
            if (['audits', 'domains'].includes(this.name)) throw new Error('Event document materialization: ' + this.name);
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
  const result = await page.evaluate(async ({ definitions, pageContext, measures }) => {
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const storage = await import(storageUrl);
    const database = await storage.openCanonicalDatabase(indexedDB);
    const done = (/** @type {IDBTransaction} */ transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    const indexNames = (/** @type {string} */ name) =>
      [...database.transaction(name).objectStore(name).indexNames];
    const indexes = {
      tools: indexNames('tools'), counters: indexNames('toolCounters'), runs: indexNames('runs')
    };
    let legacyToolError = '';
    try {
      storage.prepareCanonicalRecord('tools', { id: 'old-event', runId: 'attempt-1', type: 'tool.call' });
    } catch (error) {
      legacyToolError = error instanceof Error ? error.message : String(error);
    }
    const at = '2026-10-03T14:00:00.000Z';
    const later = '2026-10-04T01:00:00.000Z';
    const revision = measures.evidenceRevision;
    const inventory = database.transaction(['repositories', 'workflows', 'runs', 'toolIdentities'], 'readwrite');
    inventory.objectStore('repositories').put({ id: 'repo', owner: 'githubnext', name: 'gh-aw-cao' });
    inventory.objectStore('workflows').put({ id: 'workflow', repositoryId: 'repo', path: 'activity.md', campaign: 'activity' });
    for (const attempt of [1, 2]) {
      inventory.objectStore('runs').put({
        id: `attempt-${attempt}`, owner: 'githubnext', repository: 'gh-aw-cao',
        workflowPath: 'activity.md', githubRunId: '42', attempt, toolUsageRevision: revision,
        timestamp: at, observedAt: later
      });
    }
    for (const [id, mcpServer, mcpTool] of [
      ['identity-0', 'server/with', 'slash/tool'],
      ['identity-1', 'server', 'with/slash/tool'],
      ['identity-other', 'other', 'unused']
    ]) {
      inventory.objectStore('toolIdentities').put({ id, mcpServer, mcpTool, name: `${mcpServer}/${mcpTool}`, observedAt: later });
    }
    await done(inventory);
    const count = 200001;
    for (let offset = 0; offset < count; offset += 5000) {
      const transaction = database.transaction('audits', 'readwrite');
      const store = transaction.objectStore('audits');
      for (let position = offset; position < Math.min(count, offset + 5000); position += 1) {
        store.put(storage.prepareCanonicalRecord('audits', {
          id: `audits-${position}`, runId: `attempt-${position % 2 + 1}`,
          source: 'audit', type: 'audit.finding',
          status: position % 3 === 0 ? 'medium' : 'high',
          timestamp: at, observedAt: later,
          ...(position % 5 === 0 ? {} : { summary: `finding-${position % 4}` })
        }));
      }
      await done(transaction);
    }
    const compact = database.transaction(['tools', 'toolCounters', 'domains', 'issues'], 'readwrite');
    for (const [id, runId, toolId, eventCount] of [
      ['tools-0', 'attempt-1', 'identity-0', 1],
      ['tools-1', 'attempt-2', 'identity-1', 1],
      ['tools-other-1', 'attempt-1', 'identity-other', 100000],
      ['tools-other-2', 'attempt-2', 'identity-other', 99999]
    ]) {
      const usage = {
        ...measures, id, runId, toolId, source: 'mcp',
        eventCount, callCount: eventCount, unmatchedCount: eventCount,
        timestamp: at, lastTimestamp: id === 'tools-other-1' ? later : at, observedAt: later
      };
      compact.objectStore('tools').put(storage.prepareCanonicalRecord('tools', usage));
      const days = id === 'tools-other-1' ? [[at, Number(eventCount) - 1], [later, 1]] : [[at, eventCount]];
      for (const [timestamp, events] of days) {
        compact.objectStore('toolCounters').put(storage.prepareCanonicalRecord('toolCounters', {
          id: `${id}:${timestamp}`, runId, usageId: id, evidenceRevision: revision,
          eventCount: events, type: 'tool.call', status: 'success',
          timestamp, lastTimestamp: timestamp, observedAt: later,
          requestBytes: 0, requestBytesCount: 0, responseBytes: 0, responseBytesCount: 0
        }));
      }
    }
    for (const position of [0, 1, 2]) {
      compact.objectStore('domains').put(storage.prepareCanonicalRecord('domains', {
        id: `domain-${position}`, runId: `attempt-${position % 2 + 1}`,
        source: 'firewall', type: position ? 'net_denied' : 'net_allowed',
        timestamp: at, observedAt: later
      }));
    }
    compact.objectStore('issues').put(storage.prepareCanonicalRecord('issues', {
      id: 'issue-0', runId: 'attempt-2', source: 'safe-output', type: 'safe_output.created',
      timestamp: at, observedAt: later
    }));
    compact.objectStore('toolCounters').put(storage.prepareCanonicalRecord('toolCounters', {
      id: 'stale-tool-counter', runId: 'attempt-1', usageId: 'tools-0', evidenceRevision: 'previous-revision',
      eventCount: 99, type: 'tool.call', status: 'failed',
      timestamp: at, lastTimestamp: at, observedAt: later,
      requestBytes: 0, requestBytesCount: 0, responseBytes: 0, responseBytesCount: 0
    }));
    await done(compact);
    database.close();
    const worker = new Worker('/aggregate-worker.js', { type: 'module' });
    try {
      const initial = /** @type {Record<string, unknown>} */ (await new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = (event) => {
          if (event.data.ready) {
            worker.postMessage({
              id: 1, operation: 'query-canonical-dashboard',
              sourceNames: ['tool-event-runs', 'domain-event-runs', 'issue-event-runs', 'event-runs',
                'indexed-audit-summary-buckets', 'opaque-tool-selection', 'tool-observations'],
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
      return { sources: { ...initial, ...pagePayload }, indexes, legacyToolError };
    } finally {
      worker.terminate();
    }
  }, { definitions: queries, pageContext, measures: canonicalToolMeasures });
  const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (result.sources);
  expect(result.indexes.tools).toEqual(['byRun', 'byTool']);
  expect(result.indexes.counters).toEqual(['byRun', 'byRunType', 'byUsage']);
  expect(result.indexes.runs).toContain('byGithubRun');
  expect(result.legacyToolError).toContain('toolId');
  for (const name of ['tool-event-runs', 'event-runs', 'indexed-audit-summary-buckets', 'opaque-tool-selection']) {
    expect(sources[name].metadata.availability).toBe('available');
    expect(sources[name].metadata['query-diagnostic']).toBeUndefined();
  }
  expect(sources['tool-event-runs'].rows.map((row) => [row['run-attempt'], row.events]).sort()).toEqual([
    [1, 100001], [2, 100000]
  ]);
  expect(sources['domain-event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(3);
  expect(sources['issue-event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(1);
  expect(sources['event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(400006);
  expect(sources['event-runs'].rows.map((row) => row['run-attempt']).sort()).toEqual([1, 2]);
  expect(sources['indexed-audit-summary-buckets'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(200001);
  expect(sources['indexed-audit-summary-buckets'].rows.every((row) => row.campaign === 'activity')).toBe(true);
  expect(sources['tool-observations'].rows).toHaveLength(5);
  expect(sources['tool-observations'].rows.reduce((sum, row) => sum + Number(row['event-count']), 0)).toBe(200001);
  expect(sources['tool-observations'].rows.filter((row) => String(row['event-timestamp']).startsWith('2026-10-04'))
    .map((row) => row['event-count'])).toEqual([1]);
  expect(sources['opaque-tool-selection'].rows).toEqual([
    { 'tool-usage-id': 'tools-0', 'call-count': 1, 'run-attempt': 1, 'opaque-label': 'server/with/slash/tool' },
    { 'tool-usage-id': 'tools-1', 'call-count': 1, 'run-attempt': 2, 'opaque-label': 'server/with/slash/tool' }
  ]);
  const view = sources['view:tool-runs:tool-runs-table:mcp-tool-calls'];
  expect(view.metadata.availability).toBe('available');
  expect(view.rows.map((row) => [row['tool-usage-id'], row['call-count']]).sort()).toEqual([['tools-0', 1], ['tools-1', 1]]);
});
