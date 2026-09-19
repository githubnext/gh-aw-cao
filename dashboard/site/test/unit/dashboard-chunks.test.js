import { describe, expect, it } from 'vitest';
import {
  dashboardPageChunkPath,
  dashboardPageIsLoaded,
  dashboardPageLazySourceNames,
  dashboardPageSourceNames,
  dashboardTableSourceNames,
  mergeDashboardPage,
  normalizeDashboardPageChunk,
  resolveDashboardDocument,
  splitDashboardDocument,
} from '../../src/dashboard-chunks.js';
import { dashboardPagePaginatedSourceBindings } from '../../src/presenter.js';

/** @returns {import('../../src/presenter.js').PresentationDocument} */
function sampleDocument() {
  return {
    languageVersion: '0.1.0',
    dashboard: {
      id: 'sample',
      title: 'Sample',
      callouts: [
        { id: 'stale', title: 'Stale', description: 'Data is stale.', 'visible-when': { source: 'callout-source', field: 'stale', equals: true } },
      ],
      queries: [
        { name: 'alpha-source', source: 'alpha' },
        { name: 'beta-source', source: 'beta' },
        { name: 'callout-source', source: 'callout' },
        { name: 'gamma-source', source: 'gamma' },
        { name: 'factory-summary', from: 'runs' },
      ],
      pages: [
        {
          id: 'alpha-page',
          kind: 'custom',
          title: 'Alpha',
          views: [{ element: 'chart', mark: 'table', data: { source: 'alpha-source' } }],
        },
        {
          id: 'beta-page',
          kind: 'custom',
          title: 'Beta',
          views: [
            { element: 'chart', data: { source: 'beta-source' } },
            { element: 'list', 'lazy-list': true, data: { source: 'gamma-source' } },
          ],
        },
        {
          id: 'templated-page',
          kind: 'built-in',
          page: 'workflows',
          title: 'Workflows',
          definition: { views: [{ element: 'chart', data: { source: 'alpha-source' } }] },
        },
        {
          id: 'factory-page',
          kind: 'custom',
          title: 'Factory',
          views: [{ element: 'factory-header', data: { source: 'factory-summary' } }],
        },
      ],
    },
  };
}

describe('dashboard-chunks source discovery', () => {
  it('collects the source names a page renders, including callouts', () => {
    expect(dashboardPageSourceNames(sampleDocument(), 'alpha-page')).toEqual(['alpha-source', 'callout-source']);
    expect(dashboardPageSourceNames(sampleDocument(), 'alpha-page', 'table')).toEqual(['alpha-source', 'callout-source']);
    expect(dashboardPageSourceNames(sampleDocument(), 'nonexistent-page')).toEqual([]);
  });

  it('requests only sources used by the selected view mode', () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'view-modes',
        title: 'View modes',
        pages: [{
          id: 'runs',
          kind: 'custom',
          title: 'Runs',
          views: [
            { id: 'trend', mark: 'chart', data: { source: 'run-trend' } },
            { id: 'rows', mark: 'table', data: { source: 'runs' } }
          ]
        }]
      }
    });

    expect(dashboardPageSourceNames(document, 'runs', 'chart')).toEqual(['run-trend']);
    expect(dashboardPageSourceNames(document, 'runs', 'table')).toEqual(['runs']);
    expect(dashboardPageSourceNames(document, 'runs', 'card')).toEqual(['runs']);
  });

  it('collects lazy-list source names separately from eager sources', () => {
    expect(dashboardPageLazySourceNames(sampleDocument(), 'beta-page')).toEqual(['gamma-source']);
    expect(dashboardPageLazySourceNames(sampleDocument(), 'alpha-page')).toEqual([]);
  });

  it('maps lazy tables and incremental charts to independently paginated view aliases', () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'pagination',
        title: 'Pagination',
        pages: [{
          id: 'runs',
          kind: 'custom',
          title: 'Runs',
          views: [
            { id: 'timeline', mark: 'chart', chart: 'swimlane', data: { source: 'gamma-source' } },
            { id: 'rows', mark: 'table', controls: 'interactive', 'lazy-list': true, data: { source: 'gamma-source' } },
          ],
        }],
      },
    });

    expect(dashboardPagePaginatedSourceBindings(document, 'runs')).toEqual({
      'view:runs:timeline:gamma-source': { sourceName: 'gamma-source', viewId: 'timeline' },
      'view:runs:rows:gamma-source': { sourceName: 'gamma-source', viewId: 'rows' }
    });
    expect(dashboardPagePaginatedSourceBindings(document, 'missing')).toEqual({});
  });

  it('collects table-mark source names for a single page or across all pages', () => {
    expect(dashboardTableSourceNames(sampleDocument(), 'alpha-page')).toEqual(['alpha-source']);
    expect(dashboardTableSourceNames(sampleDocument(), 'beta-page')).toEqual([]);
    expect(dashboardTableSourceNames(sampleDocument())).toEqual(['alpha-source']);
  });

  it('resolves built-in page payloads from their definition, not top-level views', () => {
    expect(dashboardPageSourceNames(sampleDocument(), 'templated-page')).toEqual(['alpha-source', 'callout-source']);
  });
});

describe('dashboardPageIsLoaded', () => {
  it('reports false for stub pages missing views/definition', () => {
    expect(dashboardPageIsLoaded(undefined)).toBe(false);
    expect(dashboardPageIsLoaded({ id: 'stub-custom', kind: 'custom' })).toBe(false);
    expect(dashboardPageIsLoaded({ id: 'stub-built-in', kind: 'built-in' })).toBe(false);
  });

  it('reports true once a page has views or a built-in definition', () => {
    expect(dashboardPageIsLoaded({ id: 'custom', kind: 'custom', views: [] })).toBe(true);
    expect(dashboardPageIsLoaded({ id: 'built-in', kind: 'built-in', definition: { views: [] } })).toBe(true);
  });
});

describe('splitDashboardDocument / resolveDashboardDocument round-trip', () => {
  it('produces a core document without inline views/definitions or top-level queries', () => {
    const { core, pageChunks } = splitDashboardDocument(sampleDocument());
    expect(core.dashboard.queries).toBeUndefined();
    for (const page of core.dashboard.pages) {
      expect(page.views).toBeUndefined();
      expect(page.definition).toBeUndefined();
      expect(typeof dashboardPageChunkPath(page)).toBe('string');
    }
    expect(pageChunks.size).toBe(4);
  });

  it('only includes the queries a page actually needs in its chunk', () => {
    const { pageChunks } = splitDashboardDocument(sampleDocument());
    const alphaChunk = pageChunks.get('alpha-page');
    expect(alphaChunk?.queries.map((query) => query.name).toSorted()).toEqual(['alpha-source', 'callout-source']);

    const betaChunk = pageChunks.get('beta-page');
    expect(betaChunk?.queries.map((query) => query.name).toSorted()).toEqual(['beta-source', 'callout-source', 'gamma-source']);

    const factoryChunk = pageChunks.get('factory-page');
    expect(factoryChunk?.queries.map((query) => query.name).toSorted()).toEqual(['callout-source', 'factory-summary']);
  });

  it('reconstructs a fully-loaded document equivalent to the original once every chunk is resolved', () => {
    const original = sampleDocument();
    const { core, pageChunks } = splitDashboardDocument(original);
    const resolved = resolveDashboardDocument(core, [...pageChunks.values()].map((chunk) => normalizeDashboardPageChunk(chunk)));

    for (const page of resolved.dashboard.pages) {
      expect(dashboardPageIsLoaded(page)).toBe(true);
    }
    expect(dashboardPageSourceNames(resolved, 'alpha-page')).toEqual(['alpha-source', 'callout-source']);
    expect(dashboardPageLazySourceNames(resolved, 'beta-page')).toEqual(['gamma-source']);
  });

  it('lazily merges a single page chunk without requiring the others', () => {
    const { core, pageChunks } = splitDashboardDocument(sampleDocument());
    const betaChunk = pageChunks.get('beta-page');
    if (!betaChunk) throw new Error('expected a beta-page chunk');
    const resolved = resolveDashboardDocument(core, [normalizeDashboardPageChunk(betaChunk)]);

    const betaPage = resolved.dashboard.pages.find((page) => page.id === 'beta-page');
    const alphaPage = resolved.dashboard.pages.find((page) => page.id === 'alpha-page');
    expect(dashboardPageIsLoaded(betaPage)).toBe(true);
    expect(dashboardPageIsLoaded(alphaPage)).toBe(false);
    // Only the beta page's queries were merged in.
    expect((resolved.dashboard.queries ?? []).map((query) => query.name).toSorted()).toEqual(['beta-source', 'callout-source', 'gamma-source']);
  });
});

describe('mergeDashboardPage', () => {
  it('overlays a loaded page payload onto a stub while preserving chunk indexing metadata', () => {
    const stub = {
      id: 'alpha-page',
      kind: 'custom',
      chunk: 'dashboard-pages/alpha-page.json',
      'source-names': ['alpha-source'],
      'lazy-source-names': [],
      'table-source-names': ['alpha-source'],
    };
    const loaded = { id: 'alpha-page', kind: 'custom', views: [{ element: 'chart' }] };
    const merged = mergeDashboardPage(stub, loaded);
    expect(merged.views).toEqual(loaded.views);
    expect(merged.chunk).toBe(stub.chunk);
    expect(merged['source-names']).toEqual(stub['source-names']);
  });
});
