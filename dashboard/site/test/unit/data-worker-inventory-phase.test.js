// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

/** @param {string} description @param {() => boolean} ready */
async function waitFor(description, ready) {
  for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  if (!ready()) throw new Error(`Timed out waiting for ${description}.`);
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('publishes inventory-only sources before historical shards finish ingesting', async () => {
  /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
  const listeners = new Map();
  /** @type {Record<string, unknown>[]} */
  const posted = [];
  globalThis.self = /** @type {typeof globalThis.self} */ (/** @type {unknown} */ ({
    addEventListener: (/** @type {string} */ type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => {
      listeners.set(type, listener);
    },
    postMessage: (/** @type {Record<string, unknown>} */ message) => {
      posted.push(structuredClone(message));
    }
  }));
  await import('../../src/data-worker.js');

  const batch = normalize(adaptCachedGhAwJsonl(`${JSON.stringify({
    schema_version: 2,
    kind: 'run',
    run: {
      run_id: 404,
      run_attempt: 1,
      organization: 'githubnext',
      repository: 'gh-cao',
      workflow_name: 'Dashboard',
      workflow_path: '.github/workflows/dashboard.md',
      status: 'completed',
      classification: 'success',
      created_at: '2026-09-09T05:00:00Z'
    }
  })}\n`).observations);
  const normalized = (/** @type {'runs' | 'records'} */ phase, /** @type {typeof batch} */ phaseBatch) => {
    const records = Object.entries(phaseBatch).flatMap(([collection, values]) =>
      values.map((record) => ({ kind: 'record', collection, record }))
    );
    return [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 4,
        sourceRecords: 1,
        phase,
        records: records.length
      },
      ...records
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  };
  const emptyBatch = /** @type {typeof batch} */ (/** @type {unknown} */ (
    Object.fromEntries(Object.keys(batch).map((collection) => [collection, []]))
  ));
  const shardStem = `gh-aw-logs-2000-a-${'c'.repeat(64)}-${'d'.repeat(16)}.jsonl`;
  const runsName = `gh-aw-logs-runs/${shardStem}`;
  const recordsName = `gh-aw-logs-records/${shardStem}`;
  const inventory = {
    'marketplace-packages': {
      rows: [{
        id: 'marketplace:package:githubnext/gh-cao:self-care',
        'registry-id': 'githubnext/gh-cao',
        'registry-name': 'Central Agentic Ops',
        'registry-precedence': 1,
        name: 'Self Care',
        repository: 'githubnext/gh-cao',
        path: 'self-care',
        ref: 'main',
        'resolved-commit': 'e'.repeat(40),
        source: 'githubnext/gh-cao/self-care@main',
        'add-command': 'gh aw add githubnext/gh-cao/self-care',
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z' }
    }
  };
  /** @type {() => void} */
  let releaseRecords = () => {};
  const recordsReady = new Promise((resolve) => {
    releaseRecords = () => resolve(undefined);
  });
  /** @type {() => void} */
  let releaseRuns = () => {};
  const runsReady = new Promise((resolve) => {
    releaseRuns = () => resolve(undefined);
  });
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/inventory-sources.json')) return Response.json(inventory);
    if (url.endsWith('/payload-hashes.json')) {
      return Response.json({ [runsName]: 'a'.repeat(64), [recordsName]: 'b'.repeat(64) });
    }
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '1' } });
    if (url.endsWith(`/${runsName}`)) await runsReady;
    // Hold record shards until the run-phase subscription has published.
    if (url.endsWith(`/${recordsName}`)) await recordsReady;
    return new Response(url.endsWith(`/${runsName}`)
      ? normalized('runs', ({
        ...emptyBatch,
        campaigns: batch.campaigns,
        repositories: batch.repositories,
        workflows: batch.workflows,
        runs: batch.runs
      }))
      : normalized('records', emptyBatch));
  });

  const context = {
    pages: [],
    queries: [
      {
        name: 'marketplace-package-summary',
        from: 'marketplace-packages',
        select: [{ field: 'id' }, { field: 'package-name' }]
      },
      { name: 'run-summary', from: 'runs', select: [{ field: 'run' }] }
    ]
  };
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'marketplace',
      sourceNames: ['marketplace-package-summary'],
      context
    }
  });
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'runs',
      sourceNames: ['run-summary'],
      context
    }
  });
  listeners.get('message')?.({
    data: {
      id: 1,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['marketplace-package-summary'],
      context
    }
  });

  const marketplacePublished = () => posted.some(({ subscriptionId, data }) =>
    subscriptionId === 'marketplace'
    && /** @type {{ 'marketplace-package-summary'?: { rows?: unknown[] } }} */ (data)?.['marketplace-package-summary']?.rows?.length === 1);
  await waitFor('the marketplace subscription to be published', marketplacePublished);
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'marketplace')).toMatchObject({
    data: {
      'marketplace-package-summary': {
        rows: [{ id: 'githubnext/gh-cao/self-care', 'package-name': 'Self Care' }]
      }
    }
  });
  // Run-dependent subscriptions must not be published from an inventory-only
  // commit, because their shards have not been ingested yet.
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'runs')).toBe(false);
  expect(posted.some(({ id }) => id === 1)).toBe(false);

  const previewContext = {
    ...context,
    pages: [{
      id: 'inventory-preview', kind: 'custom',
      views: [{ id: 'package-table', mark: 'table', data: {
        source: 'package-execution-summary', 'partial-source': 'marketplace-package-summary'
      } }]
    }],
    queries: [...context.queries, {
      name: 'package-execution-summary', from: 'marketplace-package-summary',
      joins: [{
        source: 'run-summary', type: 'left',
        on: [{ left: 'id', right: 'run' }], fields: [{ field: 'run', as: 'latest-run' }]
      }],
      select: [{ field: 'id' }, { field: 'package-name' }]
    }]
  };
  listeners.get('message')?.({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId: 'late-preview',
    sourceNames: ['package-execution-summary'], pageId: 'inventory-preview', viewId: 'package-table',
    context: previewContext
  } });
  await waitFor('a newly subscribed partial view', () => posted.some(({ subscriptionId }) => subscriptionId === 'late-preview'));
  const preview = posted.find(({ subscriptionId }) => subscriptionId === 'late-preview');
  expect(preview?.partial).toBe(true);
  expect(Object.values(/** @type {Record<string, { rows: unknown[] }>} */ (preview?.data))
    .some((source) => JSON.stringify(source.rows).includes('Self Care'))).toBe(true);
  expect(posted.some(({ id }) => id === 1)).toBe(false);

  const pagePreviewContext = {
    ...previewContext,
    queries: [...previewContext.queries, {
      name: 'package-record-summary', from: 'package-execution-summary',
      joins: [{
        source: 'tools', type: 'left',
        on: [{ left: 'id', right: 'run' }], fields: [{ field: 'id', as: 'evidence' }]
      }]
    }],
    pages: [{
      id: 'page-preview', kind: 'custom', 'query-binding': 'page',
      views: [
        { id: 'complete-chart', mark: 'chart', data: { source: 'package-record-summary' } },
        { id: 'package-table', mark: 'table', data: {
          source: 'package-record-summary', 'partial-source': 'marketplace-package-summary'
        } },
        { id: 'run-table', mark: 'table', data: {
          source: 'package-record-summary', 'partial-source': 'run-summary'
        } }
      ]
    }]
  };
  listeners.get('message')?.({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId: 'page-preview',
    sourceNames: ['package-record-summary'], pageId: 'page-preview', context: pagePreviewContext
  } });
  const pagePreviews = () => posted.filter(({ subscriptionId, partial }) =>
    subscriptionId === 'page-preview' && partial === true);
  await waitFor('the inventory-phase page preview', () => pagePreviews().length === 1);
  const packageAlias = 'view:page-preview:package-table:package-record-summary';
  const runAlias = 'view:page-preview:run-table:package-record-summary';
  expect(pagePreviews()[0]).toMatchObject({
    data: { [packageAlias]: {
      rows: [{ 'package-name': 'Self Care' }], metadata: { 'projection-state': 'pending' }
    } }
  });
  expect(Object.keys(/** @type {object} */ (pagePreviews()[0].data))).toEqual([packageAlias]);

  listeners.get('message')?.({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId: 'filtered-page-preview',
    sourceNames: ['package-record-summary'], pageId: 'page-preview', context: pagePreviewContext,
    queryContext: { filters: { campaign: ['selected'] } }
  } });
  releaseRuns();
  await waitFor('the runs subscription to be published before record ingestion',
    () => posted.some(({ subscriptionId }) => subscriptionId === 'runs'));
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'runs')).toMatchObject({
    data: { 'run-summary': { rows: [{ run: '404' }] } }
  });
  const { processDataRequest } = await import('../../src/data-worker.js');
  expect(await processDataRequest({ operation: 'read-dashboard-snapshot' })).toBeNull();
  expect(posted.some(({ id }) => id === 1)).toBe(false);
  await waitFor('the run-phase page preview', () => pagePreviews().length === 2);
  expect(pagePreviews()[1]).toMatchObject({ data: {
    [packageAlias]: { rows: [{ 'package-name': 'Self Care' }], metadata: { 'projection-state': 'pending' } },
    [runAlias]: { rows: [{ run: '404' }], metadata: { 'projection-state': 'pending' } }
  } });
  expect(Object.keys(/** @type {object} */ (pagePreviews()[1].data)).sort()).toEqual([packageAlias, runAlias].sort());
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'filtered-page-preview')).toBe(false);

  releaseRecords();
  await waitFor('the ingestion request to complete', () => posted.some(({ id }) => id === 1));
  expect(posted.find(({ id }) => id === 1)?.error).toBeUndefined();
  await waitFor('the runs subscription to be published',
    () => posted.some(({ subscriptionId }) => subscriptionId === 'runs'));
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'runs')).toMatchObject({
    data: { 'run-summary': { rows: [{ run: '404' }] } }
  });
  await waitFor('the completed preview subscription', () => posted.some(
    ({ subscriptionId, partial }) => subscriptionId === 'late-preview' && partial !== true
  ));
  await waitFor('the complete page projection', () => posted.some(
    ({ subscriptionId, partial }) => subscriptionId === 'page-preview' && partial !== true
  ));
  const completePage = posted.find(({ subscriptionId, partial }) =>
    subscriptionId === 'page-preview' && partial !== true);
  expect(Object.keys(/** @type {object} */ (completePage?.data))).toHaveLength(3);
  expect(Object.values(/** @type {Record<string, { metadata: Record<string, unknown> }>} */ (completePage?.data))
    .every(({ metadata }) => metadata['projection-state'] !== 'pending')).toBe(true);
  expect(posted.some(({ subscriptionId, partial }) => subscriptionId === 'filtered-page-preview' && partial)).toBe(false);
}, 30_000);
