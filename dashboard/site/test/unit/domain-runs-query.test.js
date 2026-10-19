// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { queryDatabaseSources, queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { DASHBOARD_QUERY_LIMITS, executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME, openCanonicalDatabase, prepareCanonicalRecord, readCollections } from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const dashboard = authoritativeDashboard.dashboard;
const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'domain-runs');
const metadata = {
  'as-of': '2026-10-02T20:00:00Z', 'artifact-generation': 'domain-runs',
  availability: 'available', completeness: 'partial', freshness: 'fresh'
};
const identity = { organization: 'org', repository: 'repo', workflow: 'worker.md', 'run-attempt': 1 };
const sources = {
  runs: { metadata, rows: [
    { ...identity, run: '42', 'started-at': metadata['as-of'], 'run-link': { href: 'https://github.com/org/repo/actions/runs/42', relation: 'run' } }
  ] },
  domains: { metadata, rows: [] },
  workflows: { metadata, rows: [identity] },
  repositories: { metadata, rows: [identity] },
  campaigns: { metadata, rows: [] }
};

/** @param {Record<string, unknown>[]} records @param {boolean} [prepare] */
async function put(records, prepare = true) {
  const [run] = (await readCollections(indexedDB, ['runs'])).runs;
  const db = await openCanonicalDatabase(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('domains', 'readwrite');
      for (const record of records) {
        const row = { ...record, runId: run.id };
        tx.objectStore('domains').put(prepare ? prepareCanonicalRecord('domains', row) : row);
      }
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** @param {string} viewId @param {Record<string, string>} [routeParameters] @param {Record<string, unknown>} [queryContext] */
function compile(viewId, routeParameters = { domain: 'selected.example' }, queryContext = {}) {
  return compileDashboardViewPayloadQueries(page, page.id, {
    queries: dashboard.queries, views: dashboard.views, viewId, routeParameters, queryContext
  });
}

/** @param {string} viewId @param {Record<string, string>} [routeParameters] @param {Record<string, unknown>} [queryContext] @param {string} [continuationToken] */
async function load(viewId, routeParameters = { domain: 'selected.example' }, queryContext = {}, continuationToken) {
  const compiled = compile(viewId, routeParameters, queryContext);
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'query-canonical-dashboard',
    context: { pages: [page], queries: dashboard.queries, views: dashboard.views },
    pageId: page.id, viewId, routeParameters, queryContext,
    sourceNames: viewId === 'domain-runs-table' ? ['domain-run-records'] : ['domain-route-record'],
    pagination: { [compiled.aliases[0]]: { limit: 25, continuationToken } }
  }));
}

beforeEach(async () => {
  vi.stubGlobal('self', { postMessage: () => {} });
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: !String(url).endsWith('/sources/manifest.json'),
    status: String(url).endsWith('/sources/manifest.json') ? 404 : 200,
    json: async () => structuredClone(sources)
  })));
  await processDataRequest({
    operation: 'load-canonical-dashboard', sourceUrl: 'https://dashboard.example/sources.json',
    sourceNames: [], context: { pages: [], queries: [] }
  });
  await put(Array.from({ length: 560 }, (_, index) => ({
    id: `domain-${String(index).padStart(4, '0')}`,
    domain: index < 60 ? 'selected.example' : `unrelated-${index}.example`,
    decision: index % 2 ? 'denied' : 'allowed',
    observedAt: `2026-10-02T${String(index % 20).padStart(2, '0')}:00:00Z`,
    requestCount: index + 1, payloadRef: `evidence-${index}`
  })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded Domain runs worker contract', () => {
  it('returns only the paginated alias and avoids whole-domain and distinct-key scans', async () => {
    const records = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const cursors = vi.spyOn(IDBIndex.prototype, 'openKeyCursor');
    const limit = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 100;
    let result;
    try {
      result = await load('domain-runs-table');
    } finally { DASHBOARD_QUERY_LIMITS['max-input-rows'] = limit; }
    const alias = compile('domain-runs-table').aliases[0];
    expect(Object.keys(result)).toEqual([alias]);
    expect(result[alias].rows).toHaveLength(25);
    expect(result[alias].metadata).toMatchObject({ 'total-row-count': 60, completeness: 'partial' });
    expect(result[alias].continuationToken).toBeTruthy();
    expect(result[alias].rows.every((row) => row.domain === 'selected.example')).toBe(true);
    expect(result[alias].rows[0]).toMatchObject({
      run: '42', 'payload-ref': expect.any(String),
      'run-link': { href: 'https://github.com/org/repo/actions/runs/42' }
    });
    expect(records.mock.contexts.filter((store) => store instanceof IDBObjectStore && store.name === 'domains')).toHaveLength(0);
    const domainCursors = cursors.mock.calls.filter((_, index) => {
      const indexObject = cursors.mock.contexts[index];
      return indexObject instanceof IDBIndex && indexObject.name === 'byQueryDomain';
    });
    expect(domainCursors).toHaveLength(1);
    expect(domainCursors[0][0]).toMatchObject({ lower: '[#' });
  });

  it('matches the ordinary query for ordering, filters, search and all observation fields', async () => {
    const queryContext = {
      filters: { decision: ['denied'] },
      search: { fields: ['repository', 'workflow'], query: 'worker' },
      orderBy: [{ field: 'observed-at', direction: 'asc' }]
    };
    const compiled = compile('domain-runs-table', undefined, queryContext);
    const canonical = await queryDatabaseSources(indexedDB, sources, ['domains']);
    const expected = executeDashboardQueries(compiled.queries, canonical, compiled.aliases)[compiled.aliases[0]];
    const actual = await load('domain-runs-table', undefined, queryContext);
    expect(actual[compiled.aliases[0]].rows).toEqual(expected.rows.slice(0, 25));
    expect(actual[compiled.aliases[0]].metadata['total-row-count']).toBe(30);
    const header = await load('domain-runs-route-chrome');
    expect(Object.values(header)[0].rows).toEqual([{ domain: 'selected.example', 'run-link': sources.runs.rows[0]['run-link'] }]);
  });

  it('paginates every matching observation exactly once and rejects cross-domain cursors', async () => {
    const ids = [];
    /** @type {string | undefined} */
    let token;
    do {
      const [source] = Object.values(await load('domain-runs-table', undefined, undefined, token));
      ids.push(...source.rows.map((row) => row.id));
      token = source.continuationToken;
      if (token) await expect(load('domain-runs-table', { domain: 'unrelated-60.example' }, undefined, token))
        .rejects.toThrow(/stale continuation token/);
    } while (token);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    await put([{ id: 'new-evidence', domain: 'selected.example', observedAt: metadata['as-of'] }]);
    expect(Object.values(await load('domain-runs-table'))[0].metadata['total-row-count']).toBe(61);
  });

  it('keeps missing and nonmatching domain routes empty', async () => {
    for (const route of /** @type {Record<string, string>[]} */ ([{}, { domain: '' }, { domain: 'not-observed.example' }])) {
      for (const view of ['domain-runs-table', 'domain-runs-route-chrome']) {
        const result = Object.values(await load(view, route))[0];
        expect(result.rows).toEqual([]);
        expect(result.metadata.availability).toBe('empty');
      }
    }
  });

  it('falls back for nullable, structured and coercible keys without changing equality semantics', async () => {
    await put([
      { id: 'array', domain: ['selected.example'] },
      { id: 'number', domain: 123 },
      { id: 'string', domain: '123' },
      { id: 'null', domain: null },
      { id: 'missing' },
      { id: 'unknown', domain: 'unknown' }
    ]);
    for (const [domain, total] of [['selected.example', 61], ['123', 2], ['unknown', 3]]) {
      const compiled = compile('domain-runs-table', { domain: String(domain) });
      const canonical = await queryDatabaseSources(indexedDB, sources, ['domains']);
      const expected = executeDashboardQueries(compiled.queries, canonical, compiled.aliases)[compiled.aliases[0]];
      const actual = Object.values(await load('domain-runs-table', { domain: String(domain) }))[0];
      expect(actual.rows).toEqual(expected.rows.slice(0, 25));
      expect(actual.metadata['total-row-count']).toBe(total);
    }
  });

  it('rejects incomplete physical indexes rather than silently dropping observations', async () => {
    await put([{ id: 'unindexed', domain: 'selected.example' }], false);
    const compiled = compile('domain-runs-table');
    expect(await queryIndexedDatabaseSources(indexedDB, sources, compiled.queries, compiled.aliases)).toEqual({});
  });
});
