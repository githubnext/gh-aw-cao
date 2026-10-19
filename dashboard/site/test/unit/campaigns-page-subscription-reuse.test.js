// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/campaigns-page-query-contract.json' with { type: 'json' };

/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
const context = { queries: authoritativeDashboard.dashboard.queries, pages: authoritativeDashboard.dashboard.pages };
const page = context.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.page);
const identity = { organization: 'example', repository: 'control', workflow: 'worker' };
const metadata = {
  'as-of': '2026-10-19T12:00:00Z', 'retrieved-at': '2026-10-19T12:00:00Z',
  completeness: 'complete', freshness: 'fresh', availability: 'available'
};
const input = {
  campaigns: { rows: ['alpha', 'beta', 'empty'].map((campaign) => ({
    campaign, 'campaign-name': campaign, 'campaign-mode': 'review', 'campaign-enabled': true
  })), metadata },
  repositories: { rows: [identity, { organization: 'example', repository: 'target' }], metadata },
  workflows: { rows: [{ ...identity, campaign: 'alpha', 'workflow-role': 'worker', 'workflow-active': 'true' }], metadata },
  runs: { rows: [{ ...identity, run: '42', 'run-attempt': 1, 'aic-total': 3,
    event: 'workflow_dispatch', 'target-repository': 'example/target',
    'run-conclusion': 'success', 'started-at': metadata['as-of'] }], metadata },
  ...Object.fromEntries(contract['quality-sources'].map((name) => [name, { rows: [], metadata }]))
};
/** @type {(event: { data: Record<string, unknown> }) => void} */
let listener;
/** @type {Array<{ subscriptionId?: string, data?: Record<string, Source>, error?: string }>} */
let posted;
/** @type {typeof import('../../src/data-worker.js').processDataRequest} */
let processDataRequest;
/** @type {typeof import('../../src/data/queries/database.js')} */
let databaseQueries;

beforeEach(async () => {
  vi.resetModules();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  posted = [];
  vi.stubGlobal('self', {
    addEventListener: (/** @type {string} */ _name, /** @type {typeof listener} */ callback) => { listener = callback; },
    postMessage: (/** @type {typeof posted[number]} */ message) => posted.push(message)
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/sources/manifest.json')
    ? Response.json({}, { status: 404 }) : Response.json(input)));
  databaseQueries = await import('../../src/data/queries/database.js');
  ({ processDataRequest } = await import('../../src/data-worker.js'));
  await processDataRequest({
    operation: 'load-canonical-dashboard', sourceUrl: 'https://dashboard.example/sources.json',
    sourceNames: [], context
  });
});

afterEach(async () => {
  for (const viewId of contract.views) listener({ data: {
    operation: 'unsubscribe-canonical-dashboard', subscriptionId: viewId
  } });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** @param {Record<string, unknown>} [queryContext] */
function subscribe(queryContext) {
  for (const viewId of contract.views) listener({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId: viewId, viewId,
    sourceNames: [contract.source], pageId: contract.page, context, queryContext
  } });
}

async function settled() {
  await vi.waitFor(() => {
    expect(posted.filter((message) => contract.views.includes(String(message.subscriptionId)))).toHaveLength(3);
  });
  for (const message of posted.filter((message) => message.subscriptionId)) expect(message.error).toBeUndefined();
}

describe('Campaigns complete subscription refresh', () => {
  it('evaluates the identical inventory once and preserves every compiled view payload and its metadata', async () => {
    const expected = await Promise.all(contract.views.map((viewId) => processDataRequest({
      operation: 'query-canonical-dashboard', sourceNames: [contract.source],
      pageId: contract.page, viewId, context
    })));
    const native = vi.spyOn(databaseQueries, 'queryIndexedDatabaseSources');
    subscribe();
    await settled();
    expect(native).toHaveBeenCalledTimes(contract['maximum-identical-evaluations-per-refresh']);
    for (const [position, viewId] of contract.views.entries()) {
      const message = posted.find((entry) => entry.subscriptionId === viewId);
      expect(message?.data).toEqual(expected[position]);
      const source = Object.values(message?.data ?? {})[0];
      expect(source.rows).toHaveLength(contract.rows);
      expect(source.rows[0]).toMatchObject({ campaign: 'alpha', runs: 1, aic: 3, dispatches: 1, 'covered-repositories': 1 });
    }
  });

  it('recomputes after a canonical refresh and emits all active views reactively', async () => {
    subscribe();
    await settled();
    posted.length = 0;
    const changed = structuredClone(input);
    changed.runs.rows[0]['aic-total'] = 9;
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/sources/manifest.json')
      ? Response.json({}, { status: 404 }) : Response.json(changed));
    const native = vi.spyOn(databaseQueries, 'queryIndexedDatabaseSources');
    await processDataRequest({
      operation: 'load-canonical-dashboard', sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: [], context
    });
    await settled();
    expect(native.mock.calls.filter((call) => [...call[3]].length > 0)).toHaveLength(1);
    for (const message of posted.filter((entry) => entry.subscriptionId)) {
      expect(Object.values(message.data ?? {})[0].rows[0]).toMatchObject({ aic: 9 });
    }
  });

  it('keeps distinct view filters isolated instead of reusing another view scope', async () => {
    const native = vi.spyOn(databaseQueries, 'queryIndexedDatabaseSources');
    for (const [position, viewId] of contract.views.entries()) listener({ data: {
      operation: 'subscribe-canonical-dashboard', subscriptionId: viewId, viewId,
      sourceNames: [contract.source], pageId: contract.page, context,
      queryContext: { filters: { campaign: [position === 1 ? 'beta' : 'alpha'] } }
    } });
    await settled();
    expect(native).toHaveBeenCalledTimes(3);
    for (const [position, viewId] of contract.views.entries()) {
      const data = posted.find((entry) => entry.subscriptionId === viewId)?.data ?? {};
      expect(Object.values(data)[0].rows.map((row) => row.campaign)).toEqual([position === 1 ? 'beta' : 'alpha']);
    }
  });

  it('paginates each view independently after reusing the complete inventory', async () => {
    const native = vi.spyOn(databaseQueries, 'queryIndexedDatabaseSources');
    for (const [position, viewId] of contract.views.entries()) listener({ data: {
      operation: 'subscribe-canonical-dashboard', subscriptionId: viewId, viewId,
      sourceNames: [contract.source], pageId: contract.page, context,
      pagination: { [`view:campaigns:${viewId}:campaign-inventory`]: { limit: position + 1 } }
    } });
    await settled();
    expect(native).toHaveBeenCalledTimes(1);
    for (const [position, viewId] of contract.views.entries()) {
      const data = posted.find((entry) => entry.subscriptionId === viewId)?.data ?? {};
      const source = Object.values(data)[0];
      expect(source.rows).toHaveLength(position + 1);
      expect(source.metadata).toMatchObject({ 'total-row-count': 3, 'query-name': `view:campaigns:${viewId}:campaign-inventory` });
      if (position < 2) expect(source.continuationToken).toEqual(expect.any(String));
      else expect(source.continuationToken).toBeUndefined();
    }
  });

  it('keeps the selected horizon in the shared compiled graph', async () => {
    const native = vi.spyOn(databaseQueries, 'queryIndexedDatabaseSources');
    subscribe({ timeWindow: { start: '2026-10-19T13:00:00Z', end: '2026-10-20T00:00:00Z' } });
    await settled();
    expect(native).toHaveBeenCalledTimes(1);
    for (const message of posted.filter((entry) => entry.subscriptionId)) {
      expect(Object.values(message.data ?? {})[0].rows[0])
        .toMatchObject({ campaign: 'alpha', runs: 0, aic: 0, dispatches: 0, 'covered-repositories': 0 });
    }
  });

  it.each(contract['quality-sources'])('preserves partial and stale %s evidence across all reused views', async (name) => {
    const changed = structuredClone(input);
    const quality = /** @type {Record<string, { metadata: typeof metadata }>} */ (changed);
    quality[name].metadata = { ...metadata, completeness: 'partial', freshness: 'stale' };
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/sources/manifest.json')
      ? Response.json({}, { status: 404 }) : Response.json(changed));
    await processDataRequest({
      operation: 'load-canonical-dashboard', sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: [], context
    });
    subscribe();
    await settled();
    for (const message of posted.filter((entry) => entry.subscriptionId)) {
      expect(Object.values(message.data ?? {})[0].metadata).toMatchObject({ freshness: 'stale', completeness: 'partial' });
    }
  });

  it('retains the authored preview, links, ordering, and complete source contracts', () => {
    for (const viewId of contract.views) {
      const compiled = compileDashboardViewPayloadQueries(page, contract.page, { queries: context.queries, viewId });
      expect(compiled.aliases).toEqual([`view:campaigns:${viewId}:campaign-inventory`]);
      expect(compiled.replacedSources).toEqual([contract.source]);
    }
  });
});
