import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dashboardPageSourceNames, dashboardPageLazySourceNames, dashboardTableSourceNames,
  resolveDashboardDocument, splitDashboardDocument
} from '../../src/dashboard-chunks.js';
import { disposeDashboard, renderDashboard } from '../../src/presenter.js';
import { processDataRequest } from '../../src/data-worker.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { DashboardServerError, queryRemoteDashboard } from '../../src/remote-data-backend.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { compileDashboardViewPayloadQueries, dashboardViewAliasName } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const contract = JSON.parse(readFileSync('test/fixtures/ingestion-backend-contract.json', 'utf8'));
const page = authoritativeDashboard.dashboard.pages.find(
  (/** @type {{ id: string }} */ page) => page.id === contract.page
);
const documentInput = {
  languageVersion: '0.1.0',
  dashboard: { ...authoritativeDashboard.dashboard, pages: [page], callouts: undefined }
};
const metadata = {
  'source-id': 'hosted-runtime-contract',
  'source-kind': 'runtime',
  'as-of': '2026-09-24T00:00:00Z',
  'retrieved-at': '2026-09-24T00:00:00Z',
  completeness: 'complete', freshness: 'fresh', availability: 'available'
};
/** @type {HTMLElement[]} */
const roots = [];

function hostedBackend() {
  const marker = document.createElement('meta');
  marker.name = 'dashboard-data-backend';
  marker.content = 'server-http';
  document.head.append(marker);
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  window.history.replaceState(null, '', '/#page-indexing');
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    disposeDashboard(root);
    root.remove();
  }
  document.head.querySelector('meta[name="dashboard-data-backend"]')?.remove();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('Ingestion backend contract', () => {
  it('selects only producible static sources before and after lazy page loading', async () => {
    const { core, pageChunks } = splitDashboardDocument(documentInput);
    const unloaded = resolveDashboardDocument(core, []);
    const loaded = resolveDashboardDocument(core, [...pageChunks.values()]);
    for (const document of [documentInput, unloaded, loaded]) {
      expect(dashboardPageSourceNames(document, contract.page).toSorted()).toEqual(contract.staticSources.toSorted());
      expect(dashboardTableSourceNames(document, contract.page)).toEqual([]);
      expect(dashboardPageLazySourceNames(document, contract.page)).toEqual([]);
    }
    const names = dashboardPageSourceNames(loaded, contract.page);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
      operation: 'query-canonical-dashboard',
      pageId: contract.page, sourceNames: names, context: loaded.dashboard
    }));
    expect(Object.values(sources).every((source) => source.metadata.availability !== 'unavailable')).toBe(true);
    expect(Object.keys(sources).join(',')).not.toMatch(/ingestion-queue-sizes|ingestion-health|github-api-usage/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not subscribe to or render hosted-only views on a static dashboard', async () => {
    const subscribe = vi.fn(async (pageId, viewId, sourceNames, options) => /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
      operation: 'query-canonical-dashboard', pageId, viewId, sourceNames,
      context: documentInput.dashboard
    }, options.signal)));
    const loader = Object.assign(vi.fn(), { subscribeViewSources: subscribe });
    const root = renderDashboard({ document: documentInput, sources: {}, loadPageSources: loader });
    roots.push(root);
    document.body.append(root);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(contract.staticSources.length));
    for (const viewId of contract.hostedViews) {
      expect(page.views.find((/** @type {{ id: string }} */ view) => view.id === viewId)?.requires?.['on-unavailable'])
        .toBe(contract.staticHostedViewBehavior);
      expect(root.querySelector(`[data-view-id="${viewId}"]`)).toBeNull();
    }
    expect(subscribe.mock.calls.flatMap((call) => call[2])).not.toEqual(expect.arrayContaining(contract.hostedSources));
    expect(subscribe.mock.calls.every((call) => call[3].signal instanceof AbortSignal)).toBe(true);
    const signal = subscribe.mock.calls[0][3].signal;
    disposeDashboard(root);
    expect(signal.aborted).toBe(true);
  });

  it('keeps authorized hosted query values through the production query and view boundary', async () => {
    hostedBackend();
    const { core } = splitDashboardDocument(documentInput);
    expect(dashboardPageSourceNames(resolveDashboardDocument(core, []), contract.page).toSorted())
      .toEqual([...contract.staticSources, ...contract.hostedSources].toSorted());
    /** @type {Record<string, any>[]} */
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/refresh')) return Response.json({ revision: 1, evaluatedAt: metadata['as-of'] });
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const inputs = Object.fromEntries(Object.entries(contract.runtimeInputs).map(([source, rows]) => [
        source, { source, rows, metadata }
      ]));
      const sources = /** @type {Record<string, any>} */ (processDataRequest({
        operation: 'execute-dashboard-queries',
        queries: [...request.queries, ...request.compiledQueries],
        sourceNames: [...request.sourceNames, ...request.aliases],
        sources: inputs
      }));
      return Response.json({ revision: 1, sources });
    }));
    const result = await queryRemoteDashboard(contract.hostedSources, documentInput.dashboard, undefined, { pageId: contract.page });
    expect(requests[0].sourceNames).toEqual(contract.hostedSources);
    expect(result.sources['ingestion-queue-sizes'].rows).toEqual([
      { queue: 'Ready and scheduled', tasks: 12 },
      { queue: 'In flight', tasks: 3 },
      { queue: 'Backfill admitted (total)', tasks: 27 }
    ]);
    expect(result.sources['ingestion-health'].rows[0]).toMatchObject({ health: 'healthy', 'queue-depth': 12 });
    expect(result.sources['github-api-usage'].rows[0]['usage-percent']).toBe(40);
    const view = page.views.find((/** @type {{ id: string }} */ view) => view.id === 'github-api-usage');
    const alias = dashboardViewAliasName(contract.page, view, page.views.indexOf(view), 'github-api-usage', 0);
    expect(result.sources[alias].rows[0]['usage-percent']).toBe(40);
    const root = renderDashboard({ document: documentInput, sources: result.sources });
    roots.push(root);
    document.body.append(root);
    await vi.waitFor(() => {
      expect(root.querySelector('[data-view-id="github-api-usage"] [data-chart-widget="line"]')).not.toBeNull();
      expect(root.querySelector('[data-view-id="ingestion-health-status"]')?.textContent).toContain('healthy');
      expect(root.querySelector('[data-view-id="ingestion-queue-sizes"]')?.textContent).toContain('27');
      for (const viewId of contract.hostedViews) {
        expect(root.querySelector(`[data-view-id="${viewId}"]`)?.hasAttribute('data-view-backend-unavailable')).toBe(false);
      }
    });
  });

  it.each([
    [403, 'Administrator authorization is required.'],
    [503, 'Collection telemetry is unavailable.']
  ])('preserves hosted failures (%s) without treating them as static unavailability', async (status, message) => {
    hostedBackend();
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/refresh')
      ? Response.json({ revision: 1, evaluatedAt: metadata['as-of'] })
      : Response.json({ error: message }, { status })));
    const loader = Object.assign(vi.fn(), {
      subscribeViewSources: vi.fn((pageId, viewId, names, options) => queryRemoteDashboard(
        names, documentInput.dashboard, undefined, { pageId, viewId, signal: options.signal }
      ).then((result) => result.sources))
    });
    const root = renderDashboard({ document: documentInput, sources: {}, loadPageSources: loader });
    roots.push(root);
    document.body.append(root);
    await vi.waitFor(() => {
      const view = root.querySelector('[data-view-id="ingestion-queue-sizes"]');
      expect(view?.querySelector('[data-view-availability="unavailable"]')).not.toBeNull();
      expect(view?.textContent).toContain(message);
      expect(view?.textContent).not.toContain('Static dashboards do not contain');
      expect(view?.hasAttribute('data-view-backend-unavailable')).toBe(false);
    });
    await expect(queryRemoteDashboard(contract.hostedSources, documentInput.dashboard))
      .rejects.toBeInstanceOf(DashboardServerError);
    expect(loader.subscribeViewSources.mock.calls.flatMap((call) => call[2]))
      .toEqual(expect.arrayContaining(contract.hostedSources));
  });

  it('keeps unavailable runtime inputs unavailable through query execution', () => {
    const queries = authoritativeDashboard.dashboard.queries;
    const sources = /** @type {Record<string, any>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries, sourceNames: contract.hostedSources,
      sources: Object.fromEntries(Object.keys(contract.runtimeInputs).map((source) => [
        source, { source, rows: [], metadata: { ...metadata, availability: 'unavailable' } }
      ]))
    }));
    for (const name of contract.hostedSources) {
      expect(sources[name]).toMatchObject({ rows: [], metadata: { availability: 'unavailable' } });
    }
  });

  it('keeps missing runtime providers unavailable, never empty or zero-valued', () => {
    const sources = /** @type {Record<string, any>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: authoritativeDashboard.dashboard.queries,
      sourceNames: contract.hostedSources, sources: {}
    }));
    for (const name of contract.hostedSources) {
      expect(sources[name]).toMatchObject({ rows: [], metadata: { availability: 'unavailable' } });
    }
  });
});

describe('generic view backend requirements', () => {
  function sourceDocument(/** @type {unknown} */ requires) {
    return JSON.stringify({
      'language-version': '0.1.0',
      dashboard: {
        id: 'backend-contract', title: 'Backend contract',
        pages: [{ id: 'diagnostics', kind: 'custom', views: [{
          id: 'count', mark: 'metric', requires,
          data: { source: 'runs' }, encoding: { value: { field: 'run', aggregate: 'count' } }
        }] }]
      }
    });
  }

  it.each(['static', 'hosted'])('validates %s requirements independently of page or source names', (backend) => {
    expect(validateDashboardDocument(sourceDocument({ backend, message: 'This backend is required.' })).ok).toBe(true);
  });

  it('accepts a hidden prerequisite without a message and an explicit message fallback', () => {
    expect(validateDashboardDocument(sourceDocument({ backend: 'hosted', 'on-unavailable': 'hide' })).ok).toBe(true);
    expect(validateDashboardDocument(sourceDocument({
      backend: 'hosted', 'on-unavailable': 'message', message: 'Hosted only.'
    })).ok).toBe(true);
  });

  it.each([null, {}, { backend: 'server-http', message: 'Required.' }, { backend: 'hosted' },
    { backend: 'hosted', message: '' }, { backend: 'hosted', 'on-unavailable': 'message' },
    { backend: 'hosted', 'on-unavailable': 'hide', message: '' },
    { backend: 'hosted', 'on-unavailable': 'unknown' },
    { backend: 'hosted', message: 'Required.', authorization: 'admin' }
  ])('rejects invalid or authority-widening requirements %j', (requires) => {
    expect(validateDashboardDocument(sourceDocument(requires)).ok).toBe(false);
  });

  it('does not compile a gated alias when an enabled view shares the source', () => {
    const payload = compileDashboardViewPayloadQueries({
      views: [
        { id: 'enabled', mark: 'table', data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } },
        { id: 'gated', mark: 'table', requires: { backend: 'hosted', message: 'Hosted only.' },
          data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } }
      ]
    }, 'generic', { backend: 'static', sourceNames: ['runs'] });
    expect(payload.aliases.join(',')).toContain('enabled');
    expect(payload.aliases.join(',')).not.toContain('gated');
  });

  it('hides a gated shared-source view without shifting later query aliases or leaving empty sections', () => {
    const views = [
      { id: 'hidden', mark: 'table', requires: { backend: 'hosted', 'on-unavailable': 'hide' },
        data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } },
      { id: 'visible', mark: 'table', data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } }
    ];
    const dashboard = {
      languageVersion: '0.1.0',
      dashboard: { id: 'generic', title: 'Generic', pages: [{ id: 'generic', kind: /** @type {const} */ ('custom'), views,
        sections: [
          { id: 'hidden-section', layout: /** @type {const} */ ('full'), views: ['hidden'] },
          { id: 'visible-section', layout: /** @type {const} */ ('full'), views: ['visible'] }
        ] }] }
    };
    const alias = dashboardViewAliasName('generic', views[1], 1, 'runs', 0);
    const payload = compileDashboardViewPayloadQueries(dashboard.dashboard.pages[0], 'generic',
      { backend: 'static', sourceNames: ['runs'] });
    expect(payload.aliases).toContain(alias);
    expect(payload.aliases.join(',')).not.toContain('hidden');
    const root = renderDashboard({ document: dashboard, sources: {
      runs: { source: 'runs', rows: [{ run: 'run-1' }], metadata: /** @type {import('../../src/presenter.js').SourceMetadata} */ (metadata) }
    } });
    roots.push(root);
    document.body.append(root);
    expect(root.querySelector('[data-view-id="hidden"]')).toBeNull();
    expect(root.querySelector('[data-section-id="hidden-section"]')).toBeNull();
    expect(root.querySelector('[data-view-id="visible"]')?.textContent).toContain('run-1');
    expect(root.querySelector('[data-section-id="visible-section"]')).not.toBeNull();
  });

  it('does not execute a gated shared-source view at the production static worker boundary', async () => {
    const sources = /** @type {Record<string, any>} */ (await processDataRequest({
      operation: 'query-canonical-dashboard', pageId: 'generic', sourceNames: ['shared-runs'],
      context: {
        queries: [{ name: 'shared-runs', from: 'runs', select: [{ field: 'run' }] }],
        pages: [{
          id: 'generic', views: [
            { id: 'enabled', mark: 'table', data: { source: 'shared-runs' }, encoding: { columns: [{ field: 'run' }] } },
            { id: 'gated', mark: 'table', requires: { backend: 'hosted', message: 'Hosted only.' },
              data: { source: 'shared-runs' }, encoding: { columns: [{ field: 'run' }] } }
          ]
        }]
      }
    }));
    expect(Object.keys(sources).join(',')).toContain('enabled');
    expect(Object.keys(sources).join(',')).not.toContain('gated');
  });

  it('does not submit a static-only shared-source view through the hosted HTTP query boundary', async () => {
    /** @type {Record<string, any>[]} */
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/refresh')) return Response.json({ revision: 1, evaluatedAt: metadata['as-of'] });
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ revision: 1, sources: {} });
    }));
    await queryRemoteDashboard(['runs'], {
      pages: [{
        id: 'generic', views: [
          { id: 'enabled', mark: 'table', data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } },
          { id: 'gated', mark: 'table', requires: { backend: 'static', message: 'Static only.' },
            data: { source: 'runs' }, encoding: { columns: [{ field: 'run' }] } }
        ]
      }]
    }, undefined, { pageId: 'generic' });
    expect(requests[0].aliases.join(',')).toContain('enabled');
    expect(requests[0].aliases.join(',')).not.toContain('gated');
  });

  it('applies requirements to reusable views and lazy/table source indexes on both backends', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        pages: [{ id: 'generic', kind: 'custom', views: ['local', 'remote'] }],
        views: [
          { id: 'local', mark: 'table', 'lazy-list': true, data: { source: 'runs' },
            requires: { backend: 'static', message: 'Static only.' } },
          { id: 'remote', mark: 'table', 'lazy-list': true, data: { source: 'collection-health' },
            requires: { backend: 'hosted', message: 'Hosted only.' } }
        ]
      }
    };
    const { core, pageChunks } = splitDashboardDocument(document);
    for (const resolved of [document, resolveDashboardDocument(core, []), resolveDashboardDocument(core, [...pageChunks.values()])]) {
      for (const backend of /** @type {const} */ (['static', 'hosted'])) {
        const expected = [backend === 'static' ? 'runs' : 'collection-health'];
        expect(dashboardPageSourceNames(resolved, 'generic', undefined, backend)).toEqual(expected);
        expect(dashboardPageLazySourceNames(resolved, 'generic', backend)).toEqual(expected);
        expect(dashboardTableSourceNames(resolved, 'generic', backend)).toEqual(expected);
      }
    }
  });
});
