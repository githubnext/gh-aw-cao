// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderDashboard as renderDashboardView, disposeDashboard, enableDashboardKeyboardNavigation, enableDashboardPageNavigation, dashboardPageLazySourceNames, resolveQueryDrillPageTitle } from '../../src/presenter.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { deriveDataHealthSources } from '../../src/data-health.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { composeDashboardDocuments } from '../../../report/compose-dashboard-documents.mjs';
import { campaignDashboardSources } from '../campaign-dashboard-documents.js';
import { applyDashboardQueries } from '../workflow-inventory-query.js';
import { resolveBuiltInPages } from '../../src/dashboard-chunks.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const builtInDashboardDocument = JSON.parse(
  readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')
);
const campaignDashboardDocuments = campaignDashboardSources.map((source) => JSON.parse(source));
const authoritativeDashboardDocument = composeDashboardDocuments(
  builtInDashboardDocument,
  campaignDashboardDocuments
);

/** @param {Parameters<typeof renderDashboardView>[0]} input */
function renderDashboard(input) {
  const resolvedDocument = resolveBuiltInPages(input.document, authoritativeDashboardDocument);
  const sources = { ...input.sources };
  if (Object.keys(input.sources).length > 0) {
    Object.assign(sources, deriveDataHealthSources(sources));
    sources['source-metadata'] = {
      source: 'source-metadata',
      rows: Object.keys(TABLE_FIELDS).map((source) => {
        const value = sources[source];
        const rows = Array.isArray(value?.rows) ? value.rows : [];
        return {
          source,
          'row-count': rows.length,
          ...value?.metadata,
          availability: value?.metadata?.availability ?? (value ? (rows.length > 0 ? 'available' : 'empty') : 'unavailable'),
          completeness: value?.metadata?.completeness ?? 'unknown',
          freshness: value?.metadata?.freshness ?? 'unknown'
        };
      }),
      metadata: {
        'source-id': 'source-metadata',
        'source-kind': 'fixture',
        'as-of': '',
        'retrieved-at': '',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      }
    };
  }
  const evaluatedAt = Object.values(sources)
    .flatMap((source) => [source?.metadata?.['coverage-end'], source?.metadata?.['as-of']])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
  const range = /** @type {{ time?: { range?: unknown } }} */ (input.document.dashboard.defaults ?? {}).time?.range;
  const rangeMatch = typeof range === 'string' ? /^([1-9][0-9]*)(h|d|w)$/.exec(range) : null;
  const rangeHours = rangeMatch
    ? Number(rangeMatch[1]) * ({ h: 1, d: 24, w: 168 }[rangeMatch[2]] ?? 0)
    : 0;
  const queryContext = evaluatedAt && rangeHours > 0
    ? {
        timeWindow: {
          start: new Date(Date.parse(evaluatedAt) - rangeHours * 3_600_000).toISOString(),
          end: evaluatedAt
        }
      }
    : undefined;
  const routeParameters = Object.fromEntries(new URLSearchParams(window.location.hash.split('?')[1] ?? ''));
  const queries = /** @type {Array<Record<string, unknown>>} */ (
    /** @type {{ queries?: unknown }} */ (input.document.dashboard).queries
    ?? authoritativeDashboardDocument.dashboard.queries
  );
  const executableQueries = queries.filter((query) => typeof query.name === 'string' && !sources[query.name]);
  /** @param {import('../../src/presenter.js').PresentableBuiltInPage | import('../../src/presenter.js').PresentableCustomPage} page */
  const pagePayload = (page) => page.kind === 'built-in'
    ? {
        ...authoritativeDashboardDocument.dashboard.pages.find((/** @type {{ kind: string, page?: string }} */ candidate) => (
          candidate.kind === 'built-in' && candidate.page === page.page
        )),
        id: page.id
      }
    : page;
  for (const page of resolvedDocument.dashboard.pages) {
    const payload = pagePayload(page);
    const compiled = compileDashboardViewPayloadQueries(payload, page.id, {
      queries: executableQueries,
      evaluatedAt,
      queryContext,
      routeParameters
    });
    Object.assign(sources, processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: [...executableQueries, ...compiled.queries],
      sources,
      sourceNames: compiled.aliases
    }));
  }
  return renderDashboardView({ ...input, document: resolvedDocument, sources });
}

/** @param {HTMLElement} rendered @param {string} pageId */
async function activatePage(rendered, pageId) {
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector(`[data-nav-page-id="${pageId}"]`));
  expect(link).not.toBeNull();
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector(`[data-page-id="${pageId}"]`)?.hasAttribute('data-page-pending')).toBe(false);
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  return rendered.querySelector(`[data-page-id="${pageId}"]`);
}

describe('dashboard DOM provenance', () => {

  it('renders independently bound elements without registering a page-wide query', () => {
    const loadPageSources = vi.fn(() => new Promise(() => {}));
    const rendered = renderDashboardView({
      document: authoritativeDashboardDocument,
      sources: {},
      loadPageSources
    });
    const overviewBefore = rendered.querySelector('[data-page-id="overview"]');
    expect(overviewBefore?.querySelector('.factory-intro')).not.toBeNull();

    expect(rendered.querySelector('[data-page-id="overview"]')).toBe(overviewBefore);
    expect(rendered.querySelector('.factory-floor')).not.toBeNull();
    expect(rendered.querySelector('[data-view-id="overview-campaigns"]')).not.toBeNull();
    expect(loadPageSources).not.toHaveBeenCalledWith('maintenance', expect.anything());
    disposeDashboard(rendered);
  });

  it('subscribes navigation indicators to their page sources', async () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        title: 'Indicator dashboard',
        pages: [
          { id: 'overview', kind: 'custom', title: 'Overview', views: [] },
          {
            id: 'maintenance',
            kind: 'custom',
            title: 'Updates',
            views: [],
            'navigation-indicator': {
              label: 'updates available',
              any: ['maintenance-campaign-updates']
            }
          }
        ],
        navigation: [
          { pages: ['overview'] },
          { label: 'Updates', placement: 'bottom', pages: ['maintenance'] }
        ]
      }
    }));
    const metadata = /** @type {const} */ ({
      'source-id': 'campaigns',
      'source-kind': 'fixture',
      'as-of': '',
      'retrieved-at': '',
      completeness: 'complete',
      freshness: 'fresh',
      availability: 'available'
    });
    /** @type {string[]} */
    const subscriptionOrder = [];
    const loadSources = vi.fn((sourceNames) => {
      subscriptionOrder.push('background');
      expect(sourceNames).toEqual(['maintenance-campaign-updates']);
      return Promise.resolve(/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ ({
        'maintenance-campaign-updates': {
          source: 'maintenance-campaign-updates',
          rows: [{ 'campaign-update-state': 'update-available' }],
          metadata
        }
      }));
    });
    const loadPageSources = /** @type {import('../../src/presenter.js').PageSourceLoader} */ (vi.fn((pageId) => {
      subscriptionOrder.push(`page:${pageId}`);
      const result = pageId === 'maintenance'
        ? { campaigns: { source: 'campaigns', rows: [{ 'campaign-update-state': 'update-available' }], metadata } }
        : {};
      return Promise.resolve(/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (result));
    }));
    loadPageSources.subscribeBackgroundSources = loadSources;

    const rendered = renderDashboardView({ document, sources: {}, loadPageSources });

    expect(subscriptionOrder.slice(0, 2)).toEqual(['page:overview', 'background']);
    expect(rendered.querySelector('[data-nav-page-id="maintenance"]')?.getAttribute('aria-label'))
      .toBe('Updates');
    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-nav-page-id="maintenance"]')?.getAttribute('aria-label'))
        .toBe('Updates, updates available');
    });
    expect(loadPageSources).not.toHaveBeenCalledWith('maintenance', expect.anything());
    expect(loadSources).toHaveBeenCalledWith(['maintenance-campaign-updates'], expect.objectContaining({
      signal: expect.any(AbortSignal),
      onUpdate: expect.any(Function)
    }));
    disposeDashboard(rendered);
  });

  it('logs and ignores navigation indicator source failures', async () => {
    const originalUrl = window.location.href;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    window.history.replaceState({}, '', '?debug=render:navigation');
    vi.resetModules();
    try {
      const { renderDashboard, disposeDashboard: dispose } = await import('../../src/presenter.js');
      const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
        languageVersion: '0.1.0',
        dashboard: {
          title: 'Indicator dashboard',
          pages: [{
            id: 'maintenance',
            kind: 'custom',
            title: 'Updates',
            views: [],
            'navigation-indicator': {
              label: 'updates available',
              any: ['maintenance-campaign-updates']
            }
          }]
        }
      }));
      const loadPageSources = /** @type {import('../../src/presenter.js').PageSourceLoader} */ (vi.fn(() => Promise.resolve({})));
      loadPageSources.subscribeBackgroundSources = vi.fn(() => Promise.reject(new Error('unavailable')));

      const rendered = renderDashboard({ document, sources: {}, loadPageSources });

      await vi.waitFor(() => {
        expect(debug).toHaveBeenCalledWith('[cao:render:navigation]', 'indicator update failed', { error: 'unavailable' });
      });
      dispose(rendered);
    } finally {
      window.history.replaceState({}, '', originalUrl);
      debug.mockRestore();
      vi.resetModules();
    }
  });

  it('loads a page chunk before mounting its independently bound elements', async () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'chunked-binding-dashboard',
        title: 'Chunked binding dashboard',
        pages: [{
          id: 'overview',
          kind: /** @type {'custom'} */ ('custom'),
          title: 'Overview',
          chunk: 'dashboard-pages/overview.json',
          'independent-source-bindings': true
        }]
      }
    }));
    const loadPageSources = /** @type {NonNullable<Parameters<typeof renderDashboardView>[0]['loadPageSources']>} */ (
      () => new Promise(() => {})
    );
    loadPageSources.prepare = async () => {
      Object.assign(document.dashboard.pages[0], {
        views: [{
          id: 'overview-header',
          title: 'Overview header',
          data: {
            sources: [
              'overview-outcome-summary',
              'overview-run-summary',
              'overview-factory-status',
              'overview-rhythm'
            ]
          },
          mark: 'element',
          element: 'factory-header'
        }]
      });
    };

    const rendered = renderDashboardView({ document, sources: {}, loadPageSources });

    await vi.waitFor(() => {
      expect(rendered.querySelector('.factory-intro')).not.toBeNull();
    });
    expect(rendered.querySelector('[data-page-id="overview"]')?.getAttribute('aria-busy')).not.toBe('true');
    disposeDashboard(rendered);
  });

  it('does not mount or query a prepared page after its navigation lifetime ends', async () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'cancelled-chunk-dashboard',
        title: 'Cancelled chunk dashboard',
        pages: [{
          id: 'overview',
          kind: 'custom',
          title: 'Overview',
          chunk: 'dashboard-pages/overview.json',
          'independent-source-bindings': true
        }]
      }
    }));
    let finishPreparation = () => {};
    const loadPageSources = vi.fn(
      /** @type {NonNullable<Parameters<typeof renderDashboardView>[0]['loadPageSources']>} */ (
        () => new Promise(() => {})
      )
    );
    loadPageSources.prepare = () => new Promise((resolve) => {
      finishPreparation = () => {
        Object.assign(document.dashboard.pages[0], {
          views: [{
            id: 'overview-header',
            data: {
              sources: [
                'overview-outcome-summary',
                'overview-run-summary',
                'overview-factory-status',
                'overview-rhythm'
              ]
            },
            mark: 'element',
            element: 'factory-header'
          }]
        });
        resolve();
      };
    });

    const rendered = renderDashboardView({ document, sources: {}, loadPageSources });
    disposeDashboard(rendered);
    finishPreparation();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadPageSources).not.toHaveBeenCalled();
    expect(rendered.querySelector('.factory-intro')).toBeNull();
  });

  it('waits for page sources when a page mixes bound elements with ordinary views', async () => {
    const rendered = renderDashboardView({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'mixed-binding-dashboard',
          title: 'Mixed binding dashboard',
          pages: [{
            id: 'overview',
            kind: 'custom',
            title: 'Overview',
            views: [
              {
                id: 'overview-header',
                title: 'Overview header',
                data: { sources: ['overview-run-summary'] },
                mark: 'element',
                element: 'factory-header'
              },
              {
                id: 'runs-table',
                title: 'Runs',
                data: { source: 'runs' },
                mark: 'table',
                encoding: { columns: [{ field: 'run' }] }
              }
            ]
          }]
        }
      },
      sources: {},
      loadPageSources: () => new Promise(() => {})
    });

    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="overview"]')?.getAttribute('aria-busy')).toBe('true');
    });
    expect(rendered.querySelector('.factory-intro')).toBeNull();
    disposeDashboard(rendered);
  });

  it('waits for section count sources that are not independently bound', async () => {
    const rendered = renderDashboardView({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'section-count-dashboard',
          title: 'Section count dashboard',
          pages: [{
            id: 'overview',
            kind: 'custom',
            title: 'Overview',
            views: [{
              id: 'overview-header',
              title: 'Overview header',
              data: { sources: ['overview-run-summary'] },
              mark: 'element',
              element: 'factory-header'
            }],
            sections: [{
              id: 'overview-section',
              title: 'Overview',
              layout: 'full',
              views: ['overview-header'],
              'count-source': 'overview-count'
            }]
          }]
        }
      },
      sources: {},
      loadPageSources: () => new Promise(() => {})
    });

    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="overview"]')?.getAttribute('aria-busy')).toBe('true');
    });
    expect(rendered.querySelector('.factory-intro')).toBeNull();
    disposeDashboard(rendered);
  });

  it('requests a refresh after pulling down from the top of Overview', () => {
    const rendered = renderDashboardView({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    document.body.replaceChildren(rendered);
    const scroller = rendered.querySelector('main.dashboard-prototype');
    const onRefresh = vi.fn();
    window.addEventListener('dashboard-refresh-request', onRefresh);
    /** @param {string} type @param {number} clientY */
    const touch = (type, clientY) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{ clientY }]
      });
      scroller?.dispatchEvent(event);
    };

    touch('touchstart', 100);
    touch('touchmove', 180);
    expect(rendered.querySelector('.overview-pull-refresh')?.textContent).toBe('Release to refresh');
    touch('touchend', 180);

    expect(onRefresh).toHaveBeenCalledOnce();
    window.removeEventListener('dashboard-refresh-request', onRefresh);
    disposeDashboard(rendered);
  });

  it('reports the paginated source shared by the runs page views', () => {
    const lazySourceNames = dashboardPageLazySourceNames(authoritativeDashboardDocument, 'runs');
    expect(lazySourceNames).toContain('runs-table');
  });

  it('selects a route drilldown parent when its route has a value', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="overview" href="#page-overview">Overview</a>
      <a data-nav-page-id="repositories" href="#page-repositories">Repositories</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-overview" data-page-id="overview"></section>
        <section class="dashboard-page" id="page-repositories" data-page-id="repositories"></section>
        <section class="dashboard-page" id="page-repository-detail" data-page-id="repository-detail" data-route-navigation-page="repositories" data-route-parameter="repository"></section>
      </main>
    `;
    document.body.append(root);
    window.history.replaceState(null, '', '/#page-repository-detail?repository=octo-org%2Fplatform');
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', () => null, 'overview');
      await vi.waitFor(() => {
        expect(root.querySelector('[data-nav-page-id="repositories"]')?.getAttribute('aria-current')).toBe('page');
      });
      disposeNavigation();
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps Settings useful while the policy source is unavailable', async () => {
    const rendered = renderDashboardView({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    const page = await activatePage(rendered, 'configuration');

    expect(page?.querySelector('.configuration-view')).not.toBeNull();
    expect(page?.textContent).toContain('The policy cannot be edited until it contains valid JSON.');
    expect(page?.textContent).not.toContain('Affected source: configuration-policy');
  });

  it('maps every rendered element and dynamic descendant to its owning JSON view when ?debug=1 is set', async () => {
    window.history.pushState(null, '', '?debug=1');
    try {
      const rendered = renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'provenance-dashboard',
            title: 'Provenance dashboard',
            pages: [{
              id: 'trace',
              kind: 'custom',
              title: 'Trace',
              views: [
                {
                  id: 'summary',
                  title: 'Summary',
                  mark: 'element',
                  element: 'link-button-list',
                  config: { 'label-field': 'metric-name', 'link-field': 'metric-link' },
                  data: { source: 'summary' }
                },
                {
                  id: 'total',
                  title: 'Total',
                  mark: 'metric',
                  data: { source: 'summary' },
                  encoding: { value: { field: 'value', aggregate: 'sum' } }
                }
              ],
              sections: [{
                id: 'main',
                title: 'Main',
                layout: 'full',
                views: ['summary', 'total']
              }]
            }]
          }
        },
        sources: {
          summary: {
            source: 'summary',
            rows: [{
              'metric-kind': 'primary',
              'metric-name': 'runs',
              'metric-link': { href: '#page-trace', label: 'View runs' },
              points: [{ x: '2026-09-07T18:00:00Z', y: 2, color: 'Runs', key: 'runs-1' }]
            }],
            metadata: {
              'source-id': 'summary-fixture',
              'source-kind': 'fixture',
              'as-of': '2026-09-07T18:00:00Z',
              'retrieved-at': '2026-09-07T18:01:00Z',
              completeness: 'complete',
              freshness: 'fresh',
              availability: 'available'
            }
          }
        }
      });

      const page = rendered.querySelector('[data-page-id="trace"]');
      const section = page?.querySelector('[data-section-id="main"]');
      const summary = page?.querySelector('[data-view-id="summary"]');
      const metric = page?.querySelector('[data-view-id="total"]');
      await vi.waitFor(() => {
        expect(rendered.getAttribute('data-json-path')).toBe('$.dashboard');
      });
      expect(rendered.querySelector('[data-nav-page-id="trace"]')?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0]');
      expect(page?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0]');
      expect(section?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].sections[0]');
      expect(summary?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
      expect(summary?.querySelector('h2')?.getAttribute('data-js-view')).toBe('link-button-list');
      expect(metric?.querySelector('.metric-value')?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[1]');
      await vi.waitFor(() => {
        expect([...rendered.querySelectorAll('*')].every((element) => element.hasAttribute('data-json-path'))).toBe(true);
      });

      const dynamicChild = rendered.ownerDocument.createElement('span');
      summary?.append(dynamicChild);
      await vi.waitFor(() => {
        expect(dynamicChild.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
        expect(dynamicChild.getAttribute('data-js-view')).toBe('link-button-list');
      });

      const replacementSection = rendered.ownerDocument.createElement('section');
      replacementSection.setAttribute('data-section-id', 'main');
      const replacementView = rendered.ownerDocument.createElement('article');
      replacementView.className = 'custom-view';
      replacementView.setAttribute('data-view-id', 'summary');
      replacementView.append(rendered.ownerDocument.createElement('dt'));
      replacementSection.append(replacementView);
      page?.replaceChildren(replacementSection);
      await vi.waitFor(() => {
        expect(replacementSection.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].sections[0]');
        expect(replacementView.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
        expect(replacementView.querySelector('dt')?.getAttribute('data-js-view')).toBe('link-button-list');
      });
    } finally {
      window.history.pushState(null, '', '/');
    }
  });

  it('surfaces a dom-provenance-error data attribute when the debug-only loader fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/dom-provenance.js', () => {
      return {
        enableDashboardDomProvenance: () => {
          throw new Error('provenance module failed to load');
        },
        annotatePageDom: () => {
          throw new Error('provenance module failed to load');
        }
      };
    });
    const { renderDashboard: renderDashboardWithFailingProvenance } = await import('../../src/presenter.js');
    window.history.pushState(null, '', '?debug=1');
    try {
      const rendered = renderDashboardWithFailingProvenance({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'provenance-error-dashboard',
            title: 'Provenance error dashboard',
            pages: [{
              id: 'trace',
              kind: 'custom',
              title: 'Trace',
              views: [],
              sections: []
            }]
          }
        },
        sources: {}
      });

      await vi.waitFor(() => {
        expect(rendered.dataset.domProvenanceError).toContain('provenance module failed to load');
      });
    } finally {
      window.history.pushState(null, '', '/');
      vi.doUnmock('../../src/dom-provenance.js');
      vi.resetModules();
    }
  });

  it('does not annotate the dashboard when ?debug=1 is absent', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'no-provenance-dashboard',
          title: 'No provenance dashboard',
          pages: [{
            id: 'trace',
            kind: 'custom',
            title: 'Trace',
            views: [],
            sections: []
          }]
        }
      },
      sources: {}
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    expect(rendered.hasAttribute('data-json-path')).toBe(false);
  });

  it('shows a neutral loading skeleton instead of unavailable source errors during initial load', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'initial-load-dashboard',
          title: 'Initial Load',
          pages: [{
            id: 'repositories',
            kind: 'custom',
            title: 'Repositories',
            views: [{
              id: 'repository-activity',
              title: 'Repository Activity',
              mark: 'table',
              data: { source: 'repository-activity' }
            }],
            sections: [{
              id: 'main',
              title: 'Main',
              layout: 'full',
              views: ['repository-activity']
            }]
          }]
        }
      },
      sources: {},
      loading: true
    });

    const page = rendered.querySelector('[data-page-id="repositories"]');
    expect(page?.getAttribute('aria-busy')).toBe('true');
    expect(page?.getAttribute('aria-label')).toBe('Loading view');
    expect(page?.querySelector('.dashboard-view-skeleton')).not.toBeNull();
    expect(page?.querySelector('.agentic-loader')).toBeNull();
    expect(page?.textContent).not.toContain('This view cannot be shown because its data source is unavailable.');
  });

});

describe('presenter built-in and custom pages', () => {
  it('renders a declarative page form before the page views', () => {
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'simulator-dashboard',
        title: 'Simulator dashboard',
        pages: [{
          id: 'simulator',
          kind: 'custom',
          title: 'Simulator',
          form: {
            title: 'Scenario',
            fields: [
              { id: 'multiplier', label: 'Multiplier', control: 'slider', default: 1, min: 0, max: 4, step: 0.25 }
            ]
          },
          views: [{
            id: 'usage',
            data: { source: 'usage' },
            mark: 'metric',
            encoding: { value: { field: 'aic', aggregate: 'sum' } }
          }]
        }]
      }
    }));
    const rendered = renderDashboard({
      document,
      sources: {
        usage: {
          source: 'usage',
          rows: [{ aic: 2 }],
          metadata: {
            'source-id': 'usage',
            'source-kind': 'fixture',
            'as-of': '2026-09-24T00:00:00Z',
            'retrieved-at': '2026-09-24T00:00:00Z',
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    });
    const page = rendered.querySelector('[data-page-id="simulator"]');
    expect(page?.querySelector(':scope > .dashboard-parameter-form')).not.toBeNull();
    const slider = page?.querySelector('input[type="range"]');
    expect(slider).toBeInstanceOf(HTMLInputElement);
    expect(/** @type {HTMLInputElement} */ (slider).value).toBe('1');
    disposeDashboard(rendered);
  });

  it('resolves reusable view IDs referenced by custom pages', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'reusable-view-dashboard',
          title: 'Reusable view dashboard',
          views: [{
            id: 'reusable-total',
            title: 'Reusable total',
            mark: 'metric',
            data: { source: 'summary' },
            encoding: {
              value: { field: 'value', aggregate: 'sum' }
            }
          }],
          pages: [{
            id: 'custom',
            kind: 'custom',
            title: 'Custom',
            views: ['reusable-total']
          }]
        }
      },
      sources: {
        summary: {
          source: 'summary',
          rows: [{ value: 7 }],
          metadata: {
            'source-id': 'summary-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-16T18:00:00Z',
            'retrieved-at': '2026-09-16T18:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const view = rendered.querySelector('[data-view-id="reusable-total"]');
    expect(view?.textContent).toContain('Reusable total');
    expect(view?.querySelector('[data-metric-value="value"]')?.textContent).toBe('7');
    expect(view?.textContent).not.toContain('Invalid custom view definition.');
  });

  it('renders the most-blocked domains pie chart and drills domain cards to workflows', async () => {
    const metadata = /** @type {const} */ ({
      'source-id': 'firewall-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-05T11:00:00Z',
      'retrieved-at': '2026-09-05T11:05:00Z',
      completeness: 'partial',
      freshness: 'fresh',
      availability: 'available'
    });
    const rows = [
      { domain: 'api.github.com', run: 4, accepted: 12, blocked: 1 },
      { domain: 'new.example', run: 2, accepted: 3, blocked: 0 },
      { domain: 'blocked.example', run: 1, accepted: 0, blocked: 3_177_281 },
      { domain: 'changed.example', run: 2, accepted: 1, blocked: 2 }
    ];
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'firewall-most-blocked-domains': { source: 'firewall-most-blocked-domains', rows, metadata },
        'firewall-domain-totals': { source: 'firewall-domain-totals', rows, metadata },
        'firewall-policy-rules': { source: 'firewall-policy-rules', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'firewall');
    expect(page?.querySelector('[data-view-id="security-firewall-most-blocked-domains"] [data-chart-widget="pie"]')).not.toBeNull();
    expect(page?.querySelector('[data-chart-category="blocked.example"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="security-firewall-most-blocked-domains"] .chart-legend-pie strong')?.textContent).toBe('3,177,281');
    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    const text = page?.textContent ?? '';
    expect(text).toContain('api.github.com');
    expect(text).toContain('new.example');
    expect(text).toContain('blocked.example');
    expect(text).toContain('changed.example');
    expect(text).toContain('Allowed');
    expect(text).toContain('Blocked');
    const firewallCard = page?.querySelector('[data-view-id="security-firewall-domains"] .entity-card-list-card');
    expect(firewallCard?.querySelector('.entity-card-list-title')?.textContent).toBe('blocked.example');
    expect([...firewallCard?.querySelectorAll('.entity-card-list-metric') ?? []].map((metric) => metric.textContent))
      .toEqual(['0Allowed', '3177281Blocked', '1Runs']);
    expect(firewallCard?.querySelector('[data-card-drill="query"]')?.getAttribute('href'))
      .toBe('#page-domain-insights?query=domain-entity-insights&title=blocked.example&domain=blocked.example');
    expect(text).not.toContain('firewall failure');
    rendered.remove();
  });

  it('renders the configured empty state when the firewall data binding is empty', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'firewall-most-blocked-domains': {
          source: 'firewall-most-blocked-domains',
          rows: [],
          metadata: {
            'source-id': 'firewall-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-05T11:00:00Z',
            'retrieved-at': '2026-09-05T11:05:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'empty'
          }
        },
        'firewall-domain-totals': {
          source: 'firewall-domain-totals',
          rows: [],
          metadata: {
            'source-id': 'firewall-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-05T11:00:00Z',
            'retrieved-at': '2026-09-05T11:05:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'empty'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'firewall');
    const view = page?.querySelector('[data-view-id="security-firewall-domains"]');
    expect(view?.getAttribute('data-view-layout')).toBe('full-view');
    expect(view?.textContent).toContain(
      'No observed firewall domains are available for this selection.'
    );
    rendered.remove();
  });


  it('renders agent and model distribution before the full-view lazy table', async () => {
    const metadata = {
      'source-id': 'usage-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', 'run-conclusion': 'success', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1001', label: 'View run 1001' } },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1002', 'run-conclusion': 'failure', engine: 'copilot', 'engine-version': '0.87.9', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1002', label: 'View run 1002' } },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.yml', run: '1003', 'run-conclusion': 'success', engine: 'pi', 'engine-version': '1.2.0', 'requested-model': 'claude-sonnet-5', 'resolved-model': 'claude-sonnet-5', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1003', label: 'View run 1003' } }
          ],
          metadata
        },
        'engines-models-usage': {
          source: 'engines-models-usage',
          rows: [
            {
              summary: 'copilot / gpt-5.6-sol',
              runs: 2,
              'minimum-aic-per-run': 4,
              'average-aic-per-run': 5,
              'maximum-aic-per-run': 6,
              'minimum-input-tokens-per-run': 100,
              'average-input-tokens-per-run': 150,
              'maximum-input-tokens-per-run': 200,
              'minimum-output-tokens-per-run': 30,
              'average-output-tokens-per-run': 45,
              'maximum-output-tokens-per-run': 60
            },
            {
              summary: 'pi / claude-sonnet-5',
              runs: 1,
              'minimum-aic-per-run': 8,
              'average-aic-per-run': 8,
              'maximum-aic-per-run': 8,
              'minimum-input-tokens-per-run': 300,
              'average-input-tokens-per-run': 300,
              'maximum-input-tokens-per-run': 300
            }
          ],
          metadata
        },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'engines-models');
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelectorAll('[data-chart-widget="pie"]')).toHaveLength(1);
    expect(page?.querySelectorAll('[data-chart-widget="horizontal-bar"]')).toHaveLength(1);
    expect(page?.querySelector('[data-view-id="engines-models-distribution"] + [data-view-id="engines-models-cost"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="engines-models-aic-insights"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="engines-models-token-insights"]')).not.toBeNull();
    expect([...(page?.querySelectorAll('[data-view-id="engines-models-cost"] .horizontal-bar-chart-label') ?? [])].map((value) => value.textContent))
      .toEqual(['pi / claude-sonnet-5', 'copilot / gpt-5.6-sol']);
    expect([...(page?.querySelectorAll('[data-view-id="engines-models-cost"] .horizontal-bar-chart-value') ?? [])].map((value) => value.textContent))
      .toEqual(['$0.08', '$0.06']);
    expect(page?.getAttribute('data-page-title')).toBe('Models & Agents');
    expect(page?.textContent).toContain('copilot');
    expect(page?.textContent).toContain('gpt-5.6-sol');
    expect(page?.textContent).toContain('claude-sonnet-5');
    expect(page?.textContent).toContain('Telemetry is partial');
    expect(page?.textContent).not.toContain('Requested model');
    expect(page?.querySelector('.view-mode-control')).not.toBeNull();
    expect(page?.textContent).not.toContain('Agent event');
    expect(page?.textContent).not.toContain('Summary');
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(4);
    // Regression: the "AIC per observed run" supplemental disclosure must stay visible
    // when the page defaults to chart mode. A `disclosure: supplemental` table is an
    // independently-collapsible detail panel, not the page's primary mode-switchable
    // content, so it must not carry `data-view-mode-content` (which the chart/table/card
    // view-mode CSS uses to hide non-matching content) or it renders empty once expanded.
    expect(page?.getAttribute('data-view-mode')).toBe('chart');
    const aicInsights = page?.querySelector('[data-view-id="engines-models-aic-insights"]');
    expect(aicInsights?.hasAttribute('data-view-mode-content')).toBe(false);
    expect(aicInsights?.querySelector('table')).not.toBeNull();
  });


  it('renders indexing trends, database table counts, and transaction cards', async () => {
    const metadata = {
      'source-id': 'transactions-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        transactions: {
          source: 'transactions',
          rows: [{
            id: 'ingest-jsonl:current:logs-1',
            kind: 'ingest-jsonl',
            createdAt: '2026-09-02T12:00:00Z',
            payloadScope: 'https://dashboard.example/gh-aw-logs-shards/logs-1.jsonl',
            payloadHash: 'sha256:abc123',
            payloadEtag: 'etag-1',
            records: 10,
            committedRecords: 9,
            rawPayloadRecords: 8,
            rawRuns: 8,
            agenticRunRecords: 7,
            agenticRuns: 6,
            duplicateRawRunObservations: 1,
            duplicateAgenticRunObservations: 2,
            unenrichedRuns: 3,
            'activity-status': 'success',
            error: ''
          }],
          metadata
        },
        'indexing-database-table-counts': {
          source: 'indexing-database-table-counts',
          rows: [{ table: 'ingestion transactions', records: 1 }],
          metadata
        },
        'indexing-daily-records': {
          source: 'indexing-daily-records',
          rows: [
            { day: '2026-09-01', records: 8 },
            { day: '2026-09-02', records: 10 }
          ],
          metadata
        },
        'indexing-daily-workflow-runs': {
          source: 'indexing-daily-workflow-runs',
          rows: [
            { day: '2026-09-01', 'workflow-runs': 6 },
            { day: '2026-09-02', 'workflow-runs': 8 }
          ],
          metadata
        }
      }
    });

    document.body.append(rendered);
    try {
      window.location.hash = '#page-indexing';
      await vi.waitFor(() => expect(rendered.querySelector('[data-page-id="indexing"]')?.hasAttribute('data-page-pending')).toBe(false));
      const page = rendered.querySelector('[data-page-id="indexing"]');
      expect(page?.querySelectorAll('[data-view-id]')).toHaveLength(4);
      expect(page?.querySelectorAll('[data-chart-widget="bar"]')).toHaveLength(2);
      expect(page?.querySelectorAll('[data-chart-widget="horizontal-bar"]')).toHaveLength(1);
      expect(page?.textContent).not.toContain('Local database');
      expect(page?.textContent).toContain('ingest-jsonl');
      const transactions = page?.querySelector('[data-view-id="transaction-entries"]');
      expect(transactions?.querySelector('.entity-card-list-card')).not.toBeNull();
      expect(transactions?.textContent).toContain('Committed records');
      expect(transactions?.textContent).toContain('Payload hash');
      expect(transactions?.querySelector('input[type="search"]')).toBeNull();
    } finally {
      rendered.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('explains when engine and model usage data is missing', async () => {
    const metadata = {
      'source-id': 'usage-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'empty'} */ ('empty')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: { source: 'runs', rows: [], metadata },
        'engines-models-usage': { source: 'engines-models-usage', rows: [], metadata },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'engines-models');
    expect(page?.textContent).toContain('No agent or model usage metadata is available.');
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    rendered.remove();
  });

  it('renders the JSON-declared workflow chart and inventory table', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'workflow-topology-dashboard',
        title: 'Workflow Topology',
        pages: [{
          id: 'workflows',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'workflows',
          title: 'Workflows',
          icon: 'rocket'
        }]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', run: '1', 'aic-total': 12 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', run: '2', 'aic-total': 18 },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', run: '3', 'aic-total': 5 }
          ],
          metadata: {
            'source-id': 'workflow-runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'dependabot', 'campaign-name': 'Dependabot', workflow: '.github/workflows/dependabot.yml', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'dependabot', 'campaign-name': 'Dependabot', workflow: '.github/workflows/dependabot-update-planner.yml', 'workflow-name': 'Dependabot / Update Planner', 'workflow-role': 'worker', 'workflow-active': 'true', 'rollout-mode': 'review' },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', 'workflow-name': 'CI', 'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'live' }
          ],
          metadata: {
            'source-id': 'workflow-topology-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', aic: 12 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', aic: 18 },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', aic: 5 }
          ],
          metadata: {
            'source-id': 'workflow-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        historical: {
          source: 'historical',
          rows: [{ record: 'older-window' }],
          metadata: {
            'source-id': 'historical-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-01T12:00:00Z',
            'retrieved-at': '2026-09-01T12:00:00Z',
            'coverage-start': '2026-01-01T00:00:00Z',
            'coverage-end': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      })
    });

    const page = rendered.querySelector('[data-page-name="workflows"]');
    expect(globalThis.document.title).toBe('Workflows · Workflow Topology');
    expect(page?.getAttribute('data-page-description')).toContain('does not assert that a dispatch occurred');
    expect(page?.querySelector('.view-metadata-summary')).toBeNull();
    expect(rendered.querySelector('.horizon-summary [aria-label="Data status"]')).toBeNull();
    expect(rendered.querySelector('.filter-tuning-controls .horizon-details [aria-label="Data status"]')).toBeNull();
    expect(page?.querySelector('[data-chart-widget="horizontal-bar"]')).not.toBeNull();
    expect([...(page?.querySelectorAll('[data-view-id="workflows-by-aic-per-run"] .horizontal-bar-chart-label') ?? [])].map((value) => value.textContent))
      .toEqual(['dependabot.yml (githubnext/gh-aw-cao)', 'ci.yml (github/target-service)']);
    expect([...(page?.querySelectorAll('[data-view-id="workflows-by-aic-per-run"] .horizontal-bar-chart-value') ?? [])].map((value) => value.textContent))
      .toEqual(['15', '5']);
    expect(page?.querySelector('[data-view-id="workflows-by-aic-per-run"] .horizontal-bar-chart-label a')?.getAttribute('href'))
      .toContain('#page-workflow-runtime?workflow=');
    expect(page?.querySelector('[data-view-id="workflows-inventory"][data-view-layout="full-view"]')).not.toBeNull();
    const rocket = rendered.querySelector('[data-nav-page-id="workflows"] .octicon-rocket');
    expect(rocket?.classList.contains('octicon-rocket')).toBe(true);
    expect(rocket?.querySelector('path')).not.toBeNull();
  });

  it('uses declared workflow identities for inventory navigation', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'workflow-topology-links-dashboard',
        title: 'Workflow Topology Links',
        pages: [
          {
            id: 'workflows',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'workflows',
            title: 'Workflows'
          },
          {
            id: 'repository-detail',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Repository',
            route: { 'hash-query-parameter': 'repository' },
            views: []
          },
          {
            id: 'workflow-runtime',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Workflow runtime',
            route: { 'hash-query-parameter': 'workflow' },
            views: []
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [],
          metadata: {
            'source-id': 'workflow-runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [],
          metadata: {
            'source-id': 'workflow-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'dependabot', 'campaign-name': 'Dependabot', workflow: '.github/workflows/dependabot.yml', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'live' },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', 'workflow-name': 'CI', 'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'unknown' }
          ],
          metadata: {
            'source-id': 'workflow-topology-links-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      })
    });

    const links = [...rendered.querySelectorAll('[data-page-name="workflows"] .chart-legend-pie a')]
      .map((link) => link.getAttribute('href'));
    expect(links).toHaveLength(0);
    expect(rendered.querySelector('[data-page-name="workflows"] table')).not.toBeNull();
    expect(rendered.querySelector('[data-page-name="workflows"] table a')?.getAttribute('href'))
      .toMatch(/^#page-workflow-runtime\?workflow=/);
    expect([...rendered.querySelectorAll('[data-page-name="workflows"] table a')]
      .every((link) => !(link.parentElement instanceof HTMLAnchorElement))).toBe(true);
  });

  it('DLS-LINK-006 DLS-LINK-007 renders worker-provided entity links in table columns and honours explicit link overrides', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'entity-link-table-dashboard',
        title: 'Entity Link Table',
        'github-url-base': 'https://github.example.com',
        pages: [
          {
            id: 'repositories',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Repositories',
            views: [
              {
                id: 'repositories-table',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'organization' },
                    { field: 'repository' }
                  ]
                }
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        repositories: {
          source: 'repositories',
          rows: [
            {
              organization: 'octo-org',
              repository: 'platform',
              'organization-link': { relation: 'organization', href: 'https://github.example.com/octo-org', label: 'octo-org' },
              'repository-link': { relation: 'repository', href: 'https://github.example.com/octo-org/platform', label: 'platform' }
            },
            {
              organization: 'octo-org',
              repository: 'overridden',
              'repository-link': { relation: 'repository', href: 'https://example.com/custom', label: 'Custom link' }
            }
          ],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const table = rendered.querySelector('table');
    const links = [...(table?.querySelectorAll('tbody a') ?? [])];
    const derivedOrganizationLink = links.find((link) => link.getAttribute('href') === 'https://github.example.com/octo-org');
    expect(derivedOrganizationLink).toBeDefined();
    const derivedRepositoryLink = links.find((link) => link.getAttribute('href') === 'https://github.example.com/octo-org/platform');
    expect(derivedRepositoryLink).toBeDefined();
    const overriddenRepositoryLink = links.find((link) => link.getAttribute('href') === 'https://example.com/custom');
    expect(overriddenRepositoryLink).toBeDefined();
    expect(links.some((link) => link.getAttribute('href') === 'https://github.example.com/octo-org/overridden')).toBe(false);
  });

  it('DLS-SAFE-011 omits repository actions when repository is absent', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'no-repository-dashboard',
        title: 'No Repository',
        pages: [{ id: 'usage', kind: /** @type {'built-in'} */ ('built-in'), page: 'usage', title: 'Usage' }]
      }
    };

    const rendered = renderDashboard({ document, sources: {} });

    expect(rendered.querySelector('.refresh-button')).toBeNull();
    expect(rendered.querySelector('.account-menu')).toBeNull();
    expect(rendered.querySelector('.report-footer .refresh-button')).toBeNull();
    expect(rendered.querySelector('.report-footer-status time')?.getAttribute('datetime')).toBeTruthy();
    expect(rendered.querySelector('.repository-link')).toBeNull();
  });

  it('renders the dashboard commit SHA in the footer', () => {
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'versioned-dashboard',
        title: 'Versioned Dashboard',
        pages: [{ id: 'usage', kind: /** @type {'built-in'} */ ('built-in'), page: 'usage', title: 'Usage' }]
      }
    };

    const rendered = renderDashboard({ document, sources: {}, commitSha });

    expect(rendered.querySelector('.report-footer-version')?.textContent).toBe('Version 0123456');
    expect(rendered.querySelector('.report-footer-version')?.getAttribute('title')).toBe(commitSha);
  });

  it('DLS-DOC-012 DLS-SAFE-011 renders a labeled GitHub repository link resolved against a custom github-url-base', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'repository-dashboard',
        title: 'Repository Dashboard',
        'github-url-base': 'https://github.example.com',
        repository: 'octo-org/agentic-operations',
        pages: [{ id: 'usage', kind: /** @type {'built-in'} */ ('built-in'), page: 'usage', title: 'Usage' }]
      }
    };

    const rendered = renderDashboard({ document, sources: {} });
    globalThis.document.body.append(rendered);

    expect(rendered.querySelector('.refresh-button')).toBeNull();
    expect(rendered.querySelector('.account-menu')).toBeNull();
    const repositoryLink = rendered.querySelector('.repository-link');
    expect(repositoryLink).not.toBeNull();
    expect(repositoryLink?.getAttribute('href')).toBe('https://github.example.com/octo-org/agentic-operations');
    expect(repositoryLink?.getAttribute('aria-label')).toBe('View octo-org/agentic-operations on GitHub');
    expect(repositoryLink?.getAttribute('title')).toBe('View octo-org/agentic-operations on GitHub');
    const themeControl = rendered.querySelector('.theme-control');
    if (!(themeControl instanceof HTMLDetailsElement)) throw new Error('appearance control did not render');
    expect(themeControl.nextElementSibling).toBe(repositoryLink);
    expect(themeControl.querySelector('summary')?.getAttribute('aria-label')).toBe('Appearance');
    expect([...themeControl.querySelectorAll('[data-theme-value]')].map((node) => node.textContent)).toEqual(['System', 'Light', 'Dark']);
    themeControl.open = true;
    /** @type {HTMLButtonElement} */ (themeControl.querySelector('[data-theme-value="dark"]')).click();
    expect(themeControl.open).toBe(false);
    expect(rendered.dataset.theme).toBe('dark');
    expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('dark');
    themeControl.open = true;
    themeControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(themeControl.open).toBe(false);
    expect(globalThis.document.activeElement).toBe(themeControl.querySelector('summary'));
    localStorage.clear();
    expect(rendered.querySelector('.sidebar-brand > span')?.textContent).toBe('agentic-operations');
    expect(rendered.querySelector('.mobile-page-header .mobile-brand-name')?.textContent).toBe('agentic-operations');
    rendered.remove();
  });

  it('routes repository entity links to the repository detail view while retaining GitHub Actions links', async () => {
    window.history.replaceState(null, '', '/#page-repositories');
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repository-routing-dashboard',
          title: 'Repository routing',
          pages: [
            {
              id: 'repositories',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repositories',
              views: [{
                id: 'repository-list',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'repository' }],
                  href: { field: 'repository-link', type: 'nominal' }
                }
              }]
            },
            {
              id: 'repository-detail',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository', 'navigation-page': 'repositories' },
              views: [{
                id: 'repository-workflow-count',
                title: 'Authored workflows',
                data: { source: 'workflows', 'route-field': 'repository-slug' },
                mark: 'metric',
                encoding: {
                  value: { field: 'workflow', type: 'quantitative', aggregate: 'count' },
                  href: { field: 'external-link', type: 'nominal' }
                }
              }]
            }
          ]
        }
      },
      sources: {
        repositories: {
          source: 'repositories',
          rows: [{
            organization: 'octo-org',
            repository: 'platform',
            'repository-slug': 'octo-org/platform',
            'repository-link': {
              relation: 'repository',
              'dashboard-href': '#page-repository-detail?repository=octo-org%2Fplatform',
              'dashboard-label': 'platform'
            }
          }],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'octo-org',
            repository: 'platform',
            workflow: '.github/workflows/review.md',
            'workflow-name': 'Review',
            'workflow-active': 'true',
            'external-link': { href: 'https://github.com/octo-org/platform/actions', label: 'Actions' }
          }],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    document.body.append(rendered);

    const repositoryLink = rendered.querySelector('[data-page-id="repositories"] tbody a');
    expect(repositoryLink?.getAttribute('href')).toBe('#page-repository-detail?repository=octo-org%2Fplatform');
    expect(repositoryLink?.getAttribute('target')).toBeNull();

    window.history.replaceState(null, '', `/${repositoryLink?.getAttribute('href')}`);
    window.dispatchEvent(new Event('hashchange'));

    expect(rendered.querySelector('[data-page-id="repository-detail"]')?.hasAttribute('hidden')).toBe(false);
    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="repository-detail"]')?.hasAttribute('data-page-pending')).toBe(false);
    });
    expect(rendered.querySelector('[data-nav-page-id="repositories"]')?.getAttribute('aria-current')).toBe('page');
    rendered.remove();
    window.history.replaceState(null, '', '/');
  });


  it('restores a saved theme before the Settings page is rendered', () => {
    try {
      localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });

      expect(rendered.dataset.theme).toBe('dark');
    } finally {
      localStorage.clear();
    }
  });

  it('does not turn agent smells into Home notifications', async () => {
    window.history.replaceState(null, '', '/#page-agents');
    const metadata = /** @type {const} */ ({
      'source-id': 'notification-agent-smell-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-07T09:00:00Z',
      'retrieved-at': '2026-09-07T09:01:00Z',
      completeness: 'complete',
      freshness: 'fresh',
      availability: 'available'
    });
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'attention-signals': { source: 'attention-signals', rows: [], metadata },
        'overview-failed-run-count': { source: 'overview-failed-run-count', rows: [{ count: 0 }], metadata },
        'overview-blocked-work-count': { source: 'overview-blocked-work-count', rows: [{ count: 0 }], metadata },
        'overview-awaiting-review-count': { source: 'overview-awaiting-review-count', rows: [{ count: 0 }], metadata },
        'overview-security-finding-count': {
          source: 'overview-security-finding-count',
          rows: [],
          metadata: { ...metadata, availability: 'unavailable' }
        },
        outcomes: { source: 'outcomes', rows: [], metadata },
        'safe-output-performance': { source: 'safe-output-performance', rows: [], metadata },
        'operational-graders': { source: 'operational-graders', rows: [], metadata },
        usage: { source: 'usage', rows: [], metadata },
        runs: { source: 'runs', rows: [], metadata },
        repositories: { source: 'repositories', rows: [], metadata },
        'work-items': { source: 'work-items', rows: [], metadata },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'githubnext', repository: 'gh-aw', 'workflow-role': 'standalone',
            workflow: '.github/workflows/review.md', 'workflow-name': 'Review agent',
            'workflow-active': 'false', 'observed-at': '2020-01-01T00:00:00Z'
          }],
          metadata
        },
        'agent-assignments': { source: 'agent-assignments', rows: [], metadata },
        'security-observations': {
          source: 'security-observations',
          rows: [{
            organization: 'githubnext', repository: 'gh-aw', workflow: '.github/workflows/review.lock.yml',
            'security-feature': 'threat-detection', 'security-analysis': 'summary',
            'security-signal': 'Malicious patch', 'security-status': 'detected',
            'observed-at': '2020-01-01T00:00:00Z'
          }],
          metadata
        }
      }
    });
    document.body.append(rendered);

    const page = await activatePage(rendered, 'overview');
    expect(page?.querySelector(':scope > .custom-view-grid')).not.toBeNull();
    expect(page?.querySelectorAll(':scope > .custom-view-grid > .custom-view')).toHaveLength(3);
    expect(page?.querySelectorAll('.factory-station')).toHaveLength(2);
    expect(page?.querySelector('.factory-intro h2')?.textContent).toBe('Your campaigns are idle.');
    expect(page?.querySelector('.notifications-inbox')).toBeNull();
    expect(page?.querySelector('.factory-status')).toBeNull();
    expect(page?.querySelector('.factory-all-clear')).toBeNull();
    expect(page?.querySelector('.home-attention-detail')).toBeNull();
    expect(page?.textContent).not.toContain('Malicious patch detected');
    rendered.remove();
  });




  it('renders conditional site-wide callouts and remembers dismissal only in memory', () => {
    window.localStorage.clear();
    sessionStorage.clear();
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'callout-dashboard',
        title: 'Callout Dashboard',
        callouts: [
          {
            id: 'operator-message',
            title: 'Operator message',
            description: 'A message for every dashboard user.',
            icon: 'megaphone',
            'navigation-page': 'usage'
          },
          {
            id: 'rate-limit-message',
            title: 'Dashboard data is partial',
            description: 'Some data could not be downloaded.',
            icon: 'alert',
            'navigation-page': 'coverage',
            'visible-when': {
              source: 'coverage-diagnostics',
              field: 'kind',
              equals: 'github-api-rate-limit-403'
            }
          }
        ],
        pages: [{
          id: 'usage',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'usage',
          title: 'Usage'
        }]
      }
    };
    const sources = {
      'coverage-diagnostics': {
        source: 'coverage-diagnostics',
        rows: [{ kind: 'github-api-rate-limit-403' }],
        metadata: {
          'source-id': 'coverage-diagnostics-fixture',
          'source-kind': 'fixture',
          'as-of': '2026-09-02T23:00:00Z',
          'retrieved-at': '2026-09-02T23:00:00Z',
          completeness: /** @type {'complete'} */ ('complete'),
          freshness: /** @type {'fresh'} */ ('fresh'),
          availability: /** @type {'available'} */ ('available')
        }
      }
    };

    const rendered = renderDashboard({ document, sources });
    expect(rendered.querySelectorAll('.site-callout')).toHaveLength(2);
    expect(rendered.querySelector('[data-site-callout="rate-limit-message"]')?.textContent).toContain('Dashboard data is partial');
    const detailsLink = /** @type {HTMLAnchorElement | null} */ (
      rendered.querySelector('[data-site-callout="rate-limit-message"] .site-callout-link')
    );
    expect(detailsLink?.getAttribute('href')).toBe('#page-coverage');
    expect(detailsLink?.textContent).toBe('View coverage');
    const navigationLink = /** @type {HTMLAnchorElement | null} */ (
      rendered.querySelector('[data-site-callout="operator-message"] .site-callout-link')
    );
    expect(navigationLink?.getAttribute('href')).toBe('#page-usage');
    expect(navigationLink?.textContent).toBe('View usage');
    const dismiss = /** @type {HTMLButtonElement | null} */ (
      rendered.querySelector('[data-site-callout="operator-message"] .site-callout-dismiss')
    );
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss Operator message');
    dismiss?.click();
    expect(rendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(window.localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);

    const rerendered = renderDashboard({ document, sources });
    expect(rerendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(rerendered.querySelector('[data-site-callout="rate-limit-message"]')).not.toBeNull();

    const complete = renderDashboard({ document, sources: {} });
    expect(complete.querySelector('[data-site-callout="rate-limit-message"]')).toBeNull();
  });

  it('collapses the sidebar to icons and restores the persisted display mode', () => {
    window.localStorage.clear();
    try {
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      const toggle = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.sidebar-toggle'));
      const shell = rendered.querySelector('.app-shell');
      const overviewLink = rendered.querySelector('[data-nav-page-id="overview"]');

      expect(toggle?.getAttribute('aria-label')).toBe('Collapse navigation');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.querySelector('.octicon-sidebar-expand')).not.toBeNull();
      expect(overviewLink?.getAttribute('title')).toBe('Overview');

      toggle?.click();

      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(toggle?.getAttribute('aria-label')).toBe('Expand navigation');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.querySelector('.octicon-sidebar-collapse')).not.toBeNull();
      expect(window.localStorage.getItem('central-agentic-ops.dashboard.sidebar-collapsed')).toBe('true');

      const restored = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      expect(restored.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(restored.querySelector('.sidebar-toggle')?.getAttribute('aria-label')).toBe('Expand navigation');
    } finally {
      window.localStorage.clear();
    }
  });

  it('keeps the sidebar interactive when localStorage is unavailable', () => {
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    try {
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      const toggle = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.sidebar-toggle'));
      const shell = rendered.querySelector('.app-shell');

      expect(shell?.classList.contains('sidebar-collapsed')).toBe(false);
      toggle?.click();
      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(toggle?.getAttribute('aria-label')).toBe('Expand navigation');
    } finally {
      if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
    }
  });

  it('renders ordered view modes in page chrome and emits worker query context', async () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'mobile-view-mode-dashboard',
        title: 'Mobile View Mode',
        pages: [{
          id: 'overview',
          kind: /** @type {'custom'} */ ('custom'),
          title: 'Overview',
          views: [{ id: 'summary', title: 'Summary', data: { source: 'runs' }, mark: 'metric', encoding: { value: { field: 'run-count', aggregate: 'sum' } } }]
        }, {
          id: 'runs',
          kind: /** @type {'custom'} */ ('custom'),
          title: 'Runs',
          views: [
            {
              id: 'runs-chart',
              title: 'Run trend',
              data: { source: 'runs' },
              mark: 'chart',
              chart: 'line',
              encoding: {
                x: { field: 'started-at', type: 'temporal' },
                y: { field: 'run-count', type: 'quantitative' }
              }
            },
            {
              id: 'runs-table',
              title: 'Runs',
              data: { source: 'runs' },
              mark: 'table',
              controls: 'interactive',
              'lazy-list': true,
              layout: 'full-view',
              encoding: {
                columns: [{ field: 'run' }]
              }
            }
          ]
        }]
      }
    };
    const sources = /** @type {Parameters<typeof renderDashboard>[0]['sources']} */ ({
      runs: {
        source: 'runs',
        rows: [{ run: '1', 'run-count': 1, 'started-at': '2026-09-16T10:00:00Z' }],
        metadata: {
          'source-id': 'runs-fixture',
          'source-kind': 'fixture',
          'as-of': '2026-09-16T10:00:00Z',
          'retrieved-at': '2026-09-16T10:00:00Z',
          availability: 'available',
          completeness: 'complete',
          freshness: 'fresh'
        }
      }
    });

    const rendered = renderDashboard({ document, sources });
    expect(rendered.querySelector('[data-page-id="overview"] .filter-bar')).toBeNull();

    const page = await activatePage(rendered, 'runs');
    const chrome = page?.querySelector(':scope > .page-chrome');
    const modeButtons = [...chrome?.querySelectorAll('[data-view-mode-value]') ?? []];
    /** @type {unknown[]} */
    const contexts = [];
    rendered.addEventListener('dashboard-query-context-change', (event) => {
      if (event instanceof CustomEvent) contexts.push(event.detail);
    });

    expect(page?.querySelector(':scope > .filter-bar')).toBeNull();
    expect(chrome?.querySelector('.filter-bar')).toBeNull();
    expect(modeButtons.map((button) => button.textContent)).toEqual(['Chart', 'Cards', 'Table']);
    expect(modeButtons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(page?.querySelector('[data-view-id="runs-chart"]')?.getAttribute('data-view-mode-content')).toBe('chart');
    expect(page?.querySelector('[data-view-id="runs-table"]')?.getAttribute('data-view-mode-content')).toBe('table');
    expect(rendered.querySelector('.mobile-view-mode-toggle')).not.toBeNull();
    /** @type {HTMLButtonElement} */ (modeButtons[1]).click();
    expect(contexts.at(-1)).toMatchObject({ pageId: 'runs', queryContext: { viewMode: 'card' } });
  });

  it('keeps the default presentation without view-mode controls when disabled', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'fixed-view-mode-dashboard',
          title: 'Fixed View Mode',
          pages: [{
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Runs',
            'view-mode-control': false,
            views: [
              {
                id: 'runs-chart',
                title: 'Run trend',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'line',
                encoding: {
                  x: { field: 'started-at', type: 'temporal' },
                  y: { field: 'run-count', type: 'quantitative' }
                }
              },
              {
                id: 'runs-table',
                title: 'Runs',
                data: { source: 'runs' },
                mark: 'table',
                encoding: { columns: [{ field: 'run' }] }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [{ run: '1', 'run-count': 1, 'started-at': '2026-09-16T10:00:00Z' }],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-16T10:00:00Z',
            'retrieved-at': '2026-09-16T10:00:00Z',
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'runs');
    expect(page?.getAttribute('data-view-mode')).toBe('chart');
    expect(page?.querySelector('.view-mode-control')).toBeNull();
    expect(page?.querySelector('[data-view-id="runs-chart"]')?.getAttribute('data-view-mode-content')).toBe('chart');
    expect(page?.querySelector('[data-view-id="runs-table"]')?.getAttribute('data-view-mode-content')).toBe('table');
  });

  it('omits page chrome when a page has only one card view mode', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'cards-only-dashboard',
          title: 'Cards only',
          pages: [{
            id: 'maintenance',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Updates',
            views: [{
              id: 'campaigns',
              title: 'Campaigns',
              data: { source: 'campaigns' },
              mark: 'list',
              list: { style: 'cards', icon: 'goal' },
              encoding: { columns: [{ field: 'campaign-name' }] }
            }]
          }]
        }
      },
      sources: {
        campaigns: {
          source: 'campaigns',
          rows: [],
          metadata: {
            'source-id': 'campaigns-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-16T10:00:00Z',
            'retrieved-at': '2026-09-16T10:00:00Z',
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'maintenance');
    expect(page?.querySelector(':scope > .page-chrome')).toBeNull();
    expect(page?.getAttribute('data-view-mode')).toBe('card');
  });

  it('includes the template default view mode in the initial page source request', async () => {
    const loadPageSources = vi.fn(
      /** @type {NonNullable<Parameters<typeof renderDashboard>[0]['loadPageSources']>} */ (async () => ({}))
    );
    renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'initial-view-mode',
          title: 'Initial view mode',
          pages: [{
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Runs',
            views: [
              { id: 'trend', mark: 'chart', data: { source: 'run-trend' } },
              { id: 'rows', mark: 'table', data: { source: 'runs' } }
            ]
          }]
        }
      },
      sources: {},
      loadPageSources
    });

    await vi.waitFor(() => expect(loadPageSources).toHaveBeenCalled());
    const initialOptions = loadPageSources.mock.calls.at(0)?.[1];
    expect(initialOptions?.queryContext).toEqual({ viewMode: 'chart' });
  });

  it('switches a standalone full-view lazy table between table and card-list modes', () => {
    window.localStorage.clear();
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'mobile-table-card-dashboard',
        title: 'Mobile Table Cards',
        pages: [{
          id: 'repositories',
          kind: /** @type {'custom'} */ ('custom'),
          title: 'Repositories',
          views: [{
            id: 'repositories-table',
            title: 'Repositories',
            data: { source: 'repositories' },
            mark: 'table',
            controls: 'interactive',
            'lazy-list': true,
            layout: 'full-view',
            encoding: {
              columns: [
                { field: 'repository-coordinate', type: 'nominal' },
                { field: 'organization', type: 'nominal' }
              ]
            }
          }]
        }],
        'card-templates': [{
          id: 'repository',
          icon: 'repo',
          title: { field: 'repository-coordinate' },
          labels: [],
          details: [{ field: 'organization' }]
        }]
      }
    };
    const rendered = renderDashboard({
      document,
      sources: {
        repositories: {
          source: 'repositories',
          rows: [{ 'repository-coordinate': 'githubnext/gh-aw-cao', organization: 'githubnext' }],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-16T10:00:00Z',
            'retrieved-at': '2026-09-16T10:00:00Z',
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    });
    const modeButtons = [...rendered.querySelectorAll('[data-view-mode-value]')];

    expect(rendered.querySelector('[data-page-id="repositories"]')?.getAttribute('data-view-mode')).toBe('table');
    expect(modeButtons.map((button) => button.textContent)).toEqual(['Cards', 'Table']);
    expect(modeButtons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(rendered.querySelector('[data-mobile-card-list] .entity-card-list-card')?.textContent).toContain('githubnext/gh-aw-cao');
  });



  it('keeps logical parent navigation available when a secondary page is loaded directly', () => {
    window.history.replaceState(null, '', '/#page-overview-failed-runs');
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    const back = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.mobile-history-back'));

    expect(back?.hidden).toBe(false);
    expect(back?.getAttribute('aria-label')).toBe('Back to Overview');
    back?.click();

    expect(window.location.hash).toBe('#page-overview');
    expect(rendered.querySelector('[data-page-id="overview"]')?.hasAttribute('hidden')).toBe(false);
    window.history.replaceState(null, '', '/');
  });



  it('uses browser navigation entries to show back only when the previous page is in the dashboard', () => {
    window.history.replaceState(null, '', '/#page-cost');
    let currentIndex = 1;
    const entries = [
      { index: 0, url: 'https://github.com/githubnext/gh-aw-cao' },
      { index: 1, url: window.location.href },
      { index: 2, url: `${window.location.origin}/#page-security` }
    ];
    const navigation = new EventTarget();
    Object.defineProperties(navigation, {
      currentEntry: { get: () => ({ index: currentIndex }) },
      entries: { value: () => entries }
    });
    Object.defineProperty(window, 'navigation', { configurable: true, value: navigation });

    try {
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      const back = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.mobile-history-back'));

      expect(back?.hidden).toBe(true);
      currentIndex = 2;
      navigation.dispatchEvent(new Event('currententrychange'));
      expect(back?.hidden).toBe(false);
      currentIndex = 1;
      navigation.dispatchEvent(new Event('currententrychange'));
      expect(back?.hidden).toBe(true);
    } finally {
      delete /** @type {Window & { navigation?: unknown }} */ (window).navigation;
      window.history.replaceState(null, '', '/');
    }
  });

  it('closes the mobile view menu on Escape and restores focus to its toggle', () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    document.body.append(rendered);
    const menu = /** @type {HTMLDetailsElement | null} */ (rendered.querySelector('.mobile-nav-menu'));
    const summary = menu?.querySelector('summary');

    menu?.setAttribute('open', '');
    menu?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(menu?.hasAttribute('open')).toBe(false);
    expect(rendered.ownerDocument.activeElement).toBe(summary);
    rendered.remove();
  });



  it('applies the JSON horizon without database counts', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'horizon-dashboard',
          title: 'Horizon Dashboard',
          horizon: {
            label: 'Data horizon',
            tooltip: {
              label: 'Data horizon details',
              description: 'Data is included from the start up to the exclusive end.',
              icon: 'question'
            }
          },
          defaults: { time: { range: '1w' } },
          pages: [{
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Runs',
            views: [{
              id: 'recent-runs',
              title: 'Recent runs',
              data: { source: 'runs' },
              mark: 'table',
              encoding: { columns: [{ field: 'run' }] }
            }]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: 'recent', 'observed-at': '2026-08-30T12:00:00Z' },
            { run: 'expired', 'observed-at': '2026-08-20T12:00:00Z' },
            { run: 'timeless' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-01T12:00:00Z',
            'retrieved-at': '2026-09-01T12:00:00Z',
            'coverage-start': '2026-08-30T12:30:00Z',
            'coverage-end': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const table = rendered.querySelector('.custom-table');
    expect(table?.textContent).toContain('recent');
    expect(table?.textContent).toContain('timeless');
    expect(table?.textContent).not.toContain('expired');
    expect(rendered.querySelector('.dashboard-horizon')?.getAttribute('data-dashboard-evaluated-at')).toBe('2026-09-01T12:00:00.000Z');
    expect(rendered.querySelector('.horizon-toggle')?.getAttribute('aria-label')).toContain('2 days');
    expect(rendered.querySelector('.dashboard-horizon .horizon-details')?.textContent).toBe(
      'Data is included from the start up to the exclusive end.StartAug 30, 2026, 12:30 PM UTCEndSep 1, 2026, 12:00 PM UTCDuration2 days'
    );
    expect(rendered.querySelector('.dashboard-horizon .horizon-details time:first-of-type')?.getAttribute('datetime')).toBe('2026-08-30T12:30:00.000Z');
    expect(rendered.querySelectorAll('.dashboard-horizon .horizon-details time')[1]?.getAttribute('datetime')).toBe('2026-09-01T12:00:00.000Z');
    expect(rendered.querySelector('.horizon-tooltip-counts')).toBeNull();
  });

  it('renders the configured Horizon immediately and updates it when page sources load', async () => {
    let publishUpdate = () => {};
    const loadPageSources = vi.fn(async (_pageId, options) => {
      publishUpdate = () => options.onUpdate({
        runs: {
          source: 'runs',
          rows: [{ run: '1', 'observed-at': '2026-09-01T11:00:00Z' }],
          metadata: {
            'source-id': 'runs',
            'source-kind': 'canonical-query',
            'as-of': '2026-09-01T12:00:00Z',
            'retrieved-at': '2026-09-01T12:00:00Z',
            'coverage-start': '2026-08-31T12:00:00Z',
            'coverage-end': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      });
      return {};
    });
    const rendered = renderDashboardView({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'horizon-dashboard',
          title: 'Horizon dashboard',
          defaults: { time: { range: '1w' } },
          pages: [{
            id: 'runs',
            kind: 'custom',
            title: 'Runs',
            views: [{
              id: 'runs-table',
              data: { source: 'runs' },
              mark: 'table',
              encoding: { columns: [{ field: 'run' }] }
            }]
          }]
        }
      },
      sources: {},
      loadPageSources
    });

    expect(rendered.querySelector('.dashboard-horizon-skeleton')).toBeNull();
    expect(rendered.querySelector('.horizon-toggle')?.getAttribute('aria-label')).toContain('1 week');
    await vi.waitFor(() => expect(loadPageSources).toHaveBeenCalled());
    publishUpdate();

    const horizon = rendered.querySelector('.dashboard-horizon');
    expect(horizon?.classList.contains('dashboard-horizon-skeleton')).toBe(false);
    expect(horizon?.querySelector('.horizon-toggle')?.getAttribute('aria-label')).toContain('1 day');
    expect(horizon?.getAttribute('data-dashboard-evaluated-at')).toBe('2026-09-01T12:00:00.000Z');
    expect(rendered.querySelector('.dashboard-horizon .horizon-details')).not.toBeNull();

    optionsOnUpdateWithNoSources();
    expect(horizon?.classList.contains('dashboard-horizon-skeleton')).toBe(false);

    function optionsOnUpdateWithNoSources() {
      const latestOptions = loadPageSources.mock.calls.at(-1)?.[1];
      expect(latestOptions).toBeDefined();
      latestOptions.onUpdate({});
    }
  });



  it('DLS-VIEW-018 DLS-VIEW-019 DLS-VIEW-020 progressively discloses supplemental views in source order', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'progressive-disclosure-dashboard',
        title: 'Progressive Disclosure',
        pages: [
          {
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'run-count',
                title: 'Run count',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              },
              {
                id: 'completed-runs',
                title: 'Completed runs',
                disclosure: 'supplemental',
                data: { source: 'runs', filters: { 'run-status': 'completed' } },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-status': 'completed' },
            { run: '2', 'run-status': 'queued' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const views = rendered.querySelectorAll('[data-page-id="runs"] > .custom-view-grid > .custom-view');
    expect(views).toHaveLength(2);
    expect(views[0]?.getAttribute('data-disclosure')).toBe('essential');
    const supplemental = /** @type {HTMLDetailsElement} */ (views[1]);
    expect(supplemental.tagName).toBe('DETAILS');
    expect(supplemental.getAttribute('data-disclosure')).toBe('supplemental');
    expect(supplemental.open).toBe(false);
    expect(supplemental.querySelector('summary')?.textContent).toContain('Completed runs');
    const supplementalContent = supplemental.querySelector(':scope > .page-section');
    expect(supplementalContent?.textContent).toContain('1');
    expect(supplementalContent?.classList.contains('custom-view')).toBe(false);
    expect(supplementalContent?.hasAttribute('data-view-layout')).toBe(false);
  });



  it('DLS-PAGE-014 DLS-PAGE-015 renders mode-filtered campaign AIC utilization and campaign-run trends', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'campaigns-dashboard',
        title: 'Campaigns Dashboard',
        pages: [{
          id: 'campaigns',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'campaigns',
          title: 'Campaigns',
          description: 'Activity from centrally managed campaigns.',
          definition: {
            'data-state': { availability: true },
            views: [
              { id: 'campaign-workflows', data: { source: 'workflows' } },
              { id: 'campaign-runs', data: { source: 'runs' } },
              { id: 'campaign-outcomes', data: { source: 'outcomes' } },
              { id: 'campaign-usage', data: { source: 'usage' } },
              { id: 'campaigns-utilization', title: 'Campaign AIC utilization', data: { sources: ['workflows', 'usage'] }, mark: 'element', element: 'campaign-utilization' },
              { id: 'campaigns-run-trend', title: 'All runs over time', data: { sources: ['workflows', 'runs', 'outcomes'] }, mark: 'element', element: 'campaign-run-trend' },
              { id: 'campaigns-summary', title: 'All output by campaign', data: { sources: ['workflows', 'usage', 'findings', 'outcomes', 'runs'] }, mark: 'element', element: 'campaign-summary-table' }
            ]
          }
        }]
      }
    };
    const metadata = {
      'source-id': 'campaigns-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-29T20:00:00Z',
      'retrieved-at': '2026-08-29T20:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document,
      sources: {
        campaigns: {
          source: 'campaigns',
          rows: [
            { campaign: 'daily-ops', 'campaign-name': 'Daily Ops' },
            { campaign: 'empty-ops', 'campaign-name': 'Empty Ops' }
          ],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'campaign-aic-allowance': 250, 'campaign-inventory-warnings': 2 },
            { organization: 'github', repository: 'gh-aw-cao', campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'campaign-aic-allowance': 250, 'campaign-inventory-warnings': 2 },
            { organization: 'github', repository: 'gh-aw-cao', campaign: 'empty-ops', 'campaign-name': 'Empty Ops', workflow: '.github/workflows/empty.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'live', 'max-ai-credits': 80, 'inventory-ready': true }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review', 'aic-total': 10 },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily-worker.md', run: '2', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'live', 'aic-total': 30 },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/unmanaged.md', run: '3', 'started-at': '2026-08-29T11:00:00Z', 'run-conclusion': 'cancelled', 'rollout-mode': 'review' }
          ],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            { campaign: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' },
            { campaign: 'daily-ops', run: '2', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:05:00Z' },
            { campaign: 'daily-ops', run: '2', 'run-conclusion': 'failure', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:06:00Z' },
            { campaign: 'daily-ops', run: 'old', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-07-01T10:00:00Z', 'observed-at': '2026-07-01T10:00:00Z' }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [
            { workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 4, 'rollout-mode': 'review' },
            { workflow: '.github/workflows/daily.md', run: '1', invocation: 'b', aic: 6, 'rollout-mode': 'review' },
            { workflow: '.github/workflows/daily-worker.md', run: '2', invocation: 'c', aic: 30, 'rollout-mode': 'live' }
          ],
          metadata: { ...metadata, completeness: /** @type {'partial'} */ ('partial') }
        },
        findings: {
          source: 'findings',
          rows: [
            { workflow: '.github/workflows/daily-worker.md', run: '2', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:05:00Z' },
            { workflow: '.github/workflows/daily-worker.md', run: '2', finding: 'warning-2', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:06:00Z' }
          ],
          metadata
        }
      }
    });

    const campaignsPage = rendered.querySelector('[data-page-name="campaigns"]');
    expect(campaignsPage?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(campaignsPage?.querySelector('[data-table-filter]')).not.toBeNull();
    const campaignSummaryRows = [...(campaignsPage?.querySelectorAll('.custom-table tbody tr') ?? [])];
    expect(campaignSummaryRows).toHaveLength(2);
    expect(campaignSummaryRows[0]?.textContent).toContain('Daily Ops');
    expect(campaignSummaryRows[0]?.textContent).toContain('40');
    expect(campaignSummaryRows[1]?.textContent).toContain('Empty Ops');
    expect(/** @type {HTMLElement | null} */ (campaignsPage?.querySelector('.data-state-summary'))?.hidden).toBe(true);

  });

  it('DLS-SEM-022 DLS-SEM-023 DLS-PAGE-014 DLS-PAGE-015 keeps campaigns repository-scoped and distinguishes unknown or unavailable telemetry', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'repository-scoped-campaigns',
        title: 'Repository-scoped campaigns',
        pages: [{
          id: 'campaigns',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'campaigns',
          title: 'Campaigns'
        }]
      }
    };
    const metadata = {
      'source-id': 'campaigns-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-29T20:00:00Z',
      'retrieved-at': '2026-08-29T20:01:00Z',
      completeness: /** @type {'complete'|'unknown'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'|'unavailable'} */ ('available')
    };
    const workflows = {
      source: 'workflows',
      rows: [
        { organization: 'octo-org', repository: 'alpha', campaign: 'daily-ops', 'campaign-name': 'Daily Ops', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'max-ai-credits': 100, 'campaign-aic-allowance': 100 },
        { organization: 'octo-org', repository: 'beta', campaign: 'daily-ops', 'campaign-name': 'Daily Ops', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'max-ai-credits': 200, 'campaign-aic-allowance': 999 }
      ],
      metadata
    };
    const runs = {
      source: 'runs',
      rows: [
        { organization: 'octo-org', repository: 'alpha', workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review', 'aic-total': 10 },
        { organization: 'octo-org', repository: 'beta', workflow: '.github/workflows/daily.md', run: '2', 'started-at': '2026-08-29T11:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'review', 'aic-total': 20 }
      ],
      metadata
    };
    const usage = {
      source: 'usage',
      rows: [
        { organization: 'octo-org', repository: 'alpha', workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 10, 'rollout-mode': 'review' },
        { organization: 'octo-org', repository: 'beta', workflow: '.github/workflows/daily.md', run: '2', invocation: 'b', aic: 20, 'rollout-mode': 'review' }
      ],
      metadata: { ...metadata, completeness: /** @type {'unknown'} */ ('unknown') }
    };

    const campaigns = {
      source: 'campaigns',
      rows: [
        { campaign: 'daily-ops', 'campaign-name': 'Daily Ops' }
      ],
      metadata
    };
    const rendered = renderDashboard({ document, sources: { campaigns, workflows, runs, usage } });
    const campaignsPage = rendered.querySelector('[data-page-name="campaigns"]');
    const rows = [...(campaignsPage?.querySelectorAll('.custom-table tbody tr') ?? [])];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('30');
    expect(campaignsPage?.querySelector('[data-table-filter]')).not.toBeNull();

    const unavailable = renderDashboard({
      document,
      sources: {
        campaigns,
        workflows,
        runs: { ...runs, rows: [], metadata: { ...metadata, availability: /** @type {'unavailable'} */ ('unavailable'), completeness: /** @type {'unknown'} */ ('unknown') } },
        usage
      }
    });
    const unavailableCampaignsPage = unavailable.querySelector('[data-page-name="campaigns"]');
    expect(unavailableCampaignsPage?.querySelector('.custom-table')).not.toBeNull();
  });


  it('DLS-PAGE-002 DLS-PAGE-006 DLS-PAGE-008 DLS-PAGE-009 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 renders built-in sections in authoritative dashboard.json view order grouped by declared source instead of hard-coded section index positions', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'view-order-dashboard',
        title: 'View Order Dashboard',
        pages: [
          {
            id: 'runs',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'runs',
            title: 'Runs',
            definition: {
              'data-state': {
                availability: true
              },
              views: [
                { id: 'runs-table', title: 'Runs Inventory First', data: { source: 'runs' } },
                { id: 'runs-status', title: 'Run Status Second', data: { source: 'runs' } },
                { id: 'outcome-counts', title: 'Outcome Counts Third', data: { source: 'outcomes' } },
                { id: 'run-conclusions', title: 'Run Conclusions Fourth', data: { source: 'runs' } }
              ]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'rollout-mode': 'live',
              engine: 'actions',
              'requested-model': 'gpt-4o',
              'resolved-model': 'gpt-4.1',
              'started-at': '2026-08-29T10:00:00Z'
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              run: '1001',
              'outcome-state': 'accepted'
            }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }, ['runs-table', 'runs-daily-conclusions'])
    });

    const headings = [...rendered.querySelectorAll('[data-page-id="runs"] .page-section h3')].map((element) => element.textContent);
    expect(headings).toEqual(['Runs in the last week', 'Runs']);
    expect(rendered.querySelectorAll('[data-page-id="runs"] [data-chart-widget="area"]')).toHaveLength(1);
    expect(rendered.querySelectorAll('[data-page-id="runs"] .custom-table')).toHaveLength(1);
    expect(rendered.querySelector('[data-page-id="runs"]')?.getAttribute('data-page-kind')).toBe('custom');
  });

  it('DLS-SAFE-003 DLS-SAFE-004 DLS-SAFE-007 DLS-SAFE-010 renders non-empty accessible names and inert text labels while preserving only safe https external link attributes', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'findings-dashboard',
        title: 'Security Dashboard',
        pages: [
          {
            id: 'finding-review',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Findings',
            views: [{
              id: 'finding-review-table',
              data: { source: 'findings' },
              mark: 'table',
              encoding: {
                columns: [
                  { field: 'finding-summary', type: 'nominal' },
                  { field: 'issue-link', type: 'nominal' }
                ],
                href: { field: 'issue-link', type: 'nominal' }
              }
            }]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        findings: {
          source: 'findings',
          rows: [
            {
              finding: 'unsafe-html',
              'finding-summary': '<img src=x onerror=alert(1)>',
              'finding-severity': 'critical',
              'finding-status': 'open',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              'observed-at': '2026-08-29T12:00:00Z',
              'issue-link': {
                relation: 'issue',
                href: 'https://example.com/issues/1',
                label: 'Issue 1 label'
              }
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelector('#page-title')?.textContent).toBe('Findings');
    expect(rendered.querySelector('.sidebar-brand > span')?.textContent).toBe('github');
    expect(rendered.querySelector('[data-page-id="finding-review"] .custom-table thead')?.textContent).toContain('Issue Link');

    const summaryCell = rendered.querySelector('[data-page-id="finding-review"] .custom-table tbody td');
    expect(summaryCell?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(summaryCell?.querySelector('img')).toBeNull();

    const issueLink = rendered.querySelector('[data-page-id="finding-review"] .custom-table tbody a');
    expect(issueLink?.getAttribute('href')).toBe('https://example.com/issues/1');
    expect(issueLink?.getAttribute('aria-label')).toBe('Issue 1 label');
    expect(issueLink?.getAttribute('target')).toBe('_blank');
    expect(issueLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(issueLink?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('DLS-VIEW-013 DLS-VIEW-014 DLS-VIEW-015 DLS-SAFE-006 renders custom views with available, empty, and unavailable states while exposing only context-permitted observations and links', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'custom-dashboard',
        title: 'Custom Dashboard',
        pages: [
          {
            id: 'custom-views',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Custom Views',
            views: [
              {
                id: 'total-aic',
                title: 'Total AI Credits',
                data: {
                  source: 'usage',
                  filters: {
                    'rollout-mode': ['review', 'live']
                  }
                },
                mark: 'metric',
                encoding: {
                  value: {
                    field: 'aic',
                    type: 'quantitative',
                    aggregate: 'sum'
                  }
                }
              },
              {
                id: 'findings-table',
                title: 'Findings Table',
                data: {
                  source: 'findings',
                  scope: {
                    repositories: ['gh-aw-cao']
                  },
                  time: {
                    start: '2026-08-29T00:00:00Z',
                    end: '2026-08-30T00:00:00Z'
                  }
                },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'finding-summary' },
                    { field: 'finding-severity' },
                    { field: 'finding-status' }
                  ],
                  href: {
                    field: 'pull-request-link'
                  }
                }
              },
              {
                id: 'daily-runs',
                title: 'Daily Runs',
                data: {
                  source: 'runs'
                },
                mark: 'chart',
                encoding: {
                  x: {
                    field: 'started-at',
                    type: 'temporal',
                    'time-unit': 'day'
                  },
                  y: {
                    field: 'run',
                    type: 'quantitative',
                    aggregate: 'count'
                  },
                  color: {
                    field: 'run-conclusion',
                    type: 'nominal'
                  },
                  href: {
                    field: 'run-link'
                  }
                }
              },
              {
                id: 'empty-usage',
                title: 'Empty Usage',
                data: {
                  source: 'empty-usage'
                },
                mark: 'metric',
                encoding: {
                  value: {
                    field: 'aic',
                    type: 'quantitative',
                    aggregate: 'sum'
                  }
                }
              },
              {
                id: 'missing-source',
                title: 'Missing Source',
                data: {
                  source: 'missing-source'
                },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'finding-summary' }
                  ]
                }
              },
              {
                id: 'missing-element-source',
                title: 'Missing Element Source',
                mark: 'element',
                element: 'control-plane-status'
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'live', aic: 2, 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'review', aic: 3, 'observed-at': '2026-08-29T11:00:00Z' }
          ],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        findings: {
          source: 'findings',
          rows: [
            {
              code: 'finding-1',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-29T12:00:00Z',
              'finding-summary': 'Unsafe dependency',
              'finding-severity': 'high',
              'finding-status': 'open',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/1',
                label: 'PR 1'
              }
            },
            {
              code: 'finding-2',
              organization: 'github',
              repository: 'other-repo',
              'observed-at': '2026-08-29T13:00:00Z',
              'finding-summary': 'Out of scope finding',
              'finding-severity': 'medium',
              'finding-status': 'resolved',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/2',
                label: 'PR 2'
              }
            },
            {
              code: 'finding-3',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-30T01:00:00Z',
              'finding-summary': 'Out of range finding',
              'finding-severity': 'low',
              'finding-status': 'open'
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        runs: {
          source: 'runs',
          rows: [
            {
              run: '1001',
              'started-at': '2026-08-29T10:00:00Z',
              'run-conclusion': 'success',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1001', label: 'Run 1001' }
            },
            {
              run: '1002',
              'started-at': '2026-08-29T11:00:00Z',
              'run-conclusion': 'failure',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1002', label: 'Run 1002' }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        'empty-usage': {
          source: 'empty-usage',
          rows: [],
          metadata: {
            'source-id': 'empty-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'unknown',
            freshness: 'unknown',
            availability: 'empty'
          }
        }
      }
    });

    expect(rendered.querySelector('#page-title')?.textContent).toBe('Custom Views');

    const metricSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Total AI Credits'));
    expect(metricSection?.querySelector('[data-metric-value="aic"]')?.textContent).toBe('5');
    expect(metricSection?.textContent).not.toContain('Source: usage');
    expect(metricSection?.textContent).not.toContain('Filters:');

    const tableSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Findings Table'));
    const tableRows = tableSection ? tableSection.querySelectorAll('.custom-table tbody tr') : null;
    expect(tableRows).toHaveLength(1);
    const linkedCell = tableRows?.[0]?.querySelector('a');
    expect(linkedCell?.textContent).toBe('Unsafe dependency');
    expect(linkedCell?.getAttribute('aria-label')).toBe('PR 1');
    expect(tableSection?.textContent).not.toContain('Scope:');
    expect(tableSection?.textContent).not.toContain('Time:');
    expect(tableSection?.textContent).not.toContain('Out of scope finding');
    expect(tableSection?.textContent).not.toContain('Out of range finding');

    const chartSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Daily Runs'));
    const chartLegendLabels = chartSection ? [...chartSection.querySelectorAll('[data-chart-legend="visual"] li span')] : [];
    expect(chartSection?.querySelector('.chart-default')).toBeNull();
    expect(chartSection?.querySelector('[data-chart-legend="text"]')).toBeNull();
    expect(chartSection?.querySelectorAll('[data-chart-legend="visual"] li')).toHaveLength(2);
    expect(chartLegendLabels.map((item) => item.textContent)).toEqual(['failure', 'success']);
    expect(chartSection?.querySelector('.table-region')).toBeNull();
    expect(chartSection?.querySelectorAll('.view-source')).toHaveLength(0);

    const emptySection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Empty Usage'));
    const emptyCard = emptySection?.querySelector('.view-state-card[data-view-state="empty"]');
    expect(emptyCard?.getAttribute('role')).toBe('status');
    expect(emptyCard?.querySelector('.octicon-info')).not.toBeNull();
    expect(emptySection?.querySelector('[data-view-availability="empty"]')?.textContent).toBe('No observations matched the effective context.');
    expect(emptySection?.textContent).toContain('Affected source: empty-usage');

    const unavailableSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Source'));
    const unavailableCard = unavailableSection?.querySelector('.view-state-card[data-view-state="unavailable"]');
    expect(unavailableCard?.getAttribute('role')).toBe('alert');
    expect(unavailableCard?.querySelector('.octicon-alert')).not.toBeNull();
    expect(unavailableSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view cannot be shown because its data source is unavailable.');
    expect(unavailableSection?.textContent).toContain('Affected source: missing-source');

    const missingElementSourceSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Element Source'));
    expect(missingElementSourceSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view cannot be shown because its data source is unavailable.');
    expect(missingElementSourceSection?.textContent).toContain('No sources declared for element view.');
  });

  it('DLS-SAFE-007 DLS-SAFE-008 enables keyboard navigation across labeled page sections without relying on color alone', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const dashboardDocument = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'runs-dashboard',
        title: 'Runs Dashboard',
        pages: [
          {
            id: 'keyboard-navigation',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Keyboard Navigation',
            views: [
              { id: 'runs-source', data: { source: 'runs' } },
              { id: 'outcomes-source', data: { source: 'outcomes' } }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document: dashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'rollout-mode': 'live',
              engine: 'actions',
              'requested-model': 'gpt-4o',
              'resolved-model': 'gpt-4.1',
              'started-at': '2026-08-29T10:00:00Z',
              'run-link': {
                relation: 'run',
                href: 'https://example.com/runs/1001',
                label: 'Run 1001'
              }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              run: '1001',
              'outcome-state': 'accepted'
            }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    rendered.ownerDocument.body.append(rendered);
    enableDashboardKeyboardNavigation(rendered);

    const sections = rendered.querySelectorAll('[data-page-id="keyboard-navigation"] .page-section');
    expect(sections).toHaveLength(2);
    expect(sections[0]?.getAttribute('aria-labelledby')).toContain('keyboard-navigation-runs-source-heading');
    expect([...sections].map((section) => section.getAttribute('aria-labelledby'))).toEqual([
      'keyboard-navigation-runs-source-heading',
      'keyboard-navigation-outcomes-source-heading'
    ]);

    const firstSection = /** @type {HTMLElement} */ (sections[0]);
    const secondSection = /** @type {HTMLElement} */ (sections[1]);

    firstSection.focus();
    firstSection.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(rendered.ownerDocument.activeElement).toBe(secondSection);

    secondSection.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(rendered.ownerDocument.activeElement).toBe(firstSection);
  });

  it('DLS-VIEW-005 DLS-VIEW-006 renders explicit line and pie widgets in the requested structural layout', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'chart-dashboard',
          title: 'Chart Dashboard',
          pages: [{
            id: 'charts',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'run-trend',
                title: 'Run Trend',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'line',
                layout: 'half',
                encoding: {
                  x: { field: 'started-at', type: 'temporal' },
                  y: { field: 'run-count', type: 'quantitative', aggregate: 'none' }
                }
              },
              {
                id: 'conclusions',
                title: 'Conclusions',
                description: 'Run conclusions grouped across the selected window.',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'pie',
                layout: 'half',
                encoding: {
                  x: { field: 'run-conclusion', type: 'nominal' },
                  y: { field: 'run', type: 'quantitative', aggregate: 'count' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { organization: 'octo-org', repository: 'repo', run: '1', 'run-count': 2, 'started-at': '2026-08-28T00:00:00Z', 'run-conclusion': 'success' },
            { organization: 'octo-org', repository: 'repo', run: '2', 'run-count': 3, 'started-at': '2026-08-29T00:00:00Z', 'run-conclusion': 'failure' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelectorAll('.custom-view-grid > [data-view-layout="half"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] polyline')?.getAttribute('points')).not.toBe('');
    expect(rendered.querySelectorAll('[data-chart-widget="line"] [role="img"][tabindex="0"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] [role="img"][tabindex="0"]')?.getAttribute('aria-label')).toContain(': 2');
    expect(rendered.querySelectorAll('[data-chart-widget="line"] .point-tooltip')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] .point-tooltip')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.querySelectorAll('[data-chart-widget="pie"] [data-chart-category]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="pie"] svg')?.getAttribute('aria-label')).toContain('Pie chart:');
    expect(rendered.querySelector('.chart-view-pie .view-description')?.textContent).toContain('Run conclusions grouped');
    expect(rendered.querySelector('.chart-view-pie .pie-chart-layout')).not.toBeNull();
  });

  it('shows one hash-addressable page at a time and updates active navigation without scrolling', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'page-navigation',
          title: 'Page Navigation',
          pages: [
            {
              id: 'first',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'First',
              description: 'First page description',
              views: [{
                id: 'first-details',
                title: 'First details',
                disclosure: 'supplemental',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              }]
            },
            { id: 'second', kind: /** @type {'custom'} */ ('custom'), title: 'Second', description: 'Second page description', experimental: true, views: [] }
          ]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [{ run: '1' }],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    rendered.ownerDocument.body.append(rendered);

    const first = /** @type {HTMLElement} */ (rendered.querySelector('#page-first'));
    const second = /** @type {HTMLElement} */ (rendered.querySelector('#page-second'));
    const firstLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-nav-page-id="first"]'));
    const secondLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-nav-page-id="second"]'));
    const firstDetails = /** @type {HTMLDetailsElement} */ (first.querySelector('details'));
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);
    expect(first.hasAttribute('data-page-pending')).toBe(false);
    expect(second.hasAttribute('data-page-pending')).toBe(true);
    firstDetails.open = true;
    const pageScroller = /** @type {HTMLElement} */ (rendered.querySelector('main.dashboard-prototype'));
    pageScroller.scrollTop = 320;
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-root]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-root]')?.hasAttribute('href')).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.getAttribute('href')).toBe('#page-first');
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(/** @type {HTMLElement} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('#page-title')?.textContent).toBe('First');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('First');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe('First page description');
    expect(/** @type {HTMLElement} */ (rendered.querySelector('.title-area [data-page-experimental]')).hidden).toBe(true);
    expect(rendered.ownerDocument.title).toBe('First · Page Navigation');
    first.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
      bubbles: true,
      detail: {
        title: 'Linked issue',
        titleLink: {
          href: 'https://github.com/octo/repo/issues/42',
          label: 'Open #42 on GitHub'
        }
      }
    }));
    const titleLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-page-title-link]'));
    expect(titleLink.hidden).toBe(false);
    expect(titleLink.textContent).toBe('Open #42 on GitHub');
    expect(titleLink.getAttribute('href')).toBe('https://github.com/octo/repo/issues/42');
    expect(titleLink.getAttribute('target')).toBe('_blank');
    expect(titleLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(titleLink.getAttribute('aria-label')).toBeNull();
    expect(titleLink.getAttribute('title')).toBe('Open #42 on GitHub');
    expect(titleLink.querySelector('.octicon-mark-github')).not.toBeNull();
    expect(rendered.ownerDocument.title).toBe('Linked issue · Page Navigation');

    secondLink.dataset.routeTitle = 'Canonical second';
    secondLink.dataset.routeDescription = 'Canonical second description';
    secondLink.click();

    expect(first.hidden).toBe(true);
    expect(first.hasAttribute('data-page-pending')).toBe(true);
    expect(first.childElementCount).toBe(0);
    expect(rendered.querySelector('#page-second')).toBe(second);
    expect(second.hidden).toBe(false);
    expect(second.hasAttribute('data-page-pending')).toBe(true);
    expect(second.getAttribute('aria-busy')).toBe('true');
    expect(second.querySelector('.dashboard-view-skeleton')).not.toBeNull();
    expect(second.getAttribute('aria-label')).toBe('Loading view');
    expect(secondLink.getAttribute('aria-current')).toBe('page');
    expect(rendered.ownerDocument.defaultView?.location.hash).toBe('#page-second');
    expect(rendered.querySelector('#page-title')?.textContent).toBe('Canonical second');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Canonical second');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe('Canonical second description');
    expect(/** @type {HTMLElement} */ (rendered.querySelector('.title-area [data-page-experimental]')).hidden).toBe(false);
    const experimentalBadge = rendered.querySelector('.title-area [data-page-experimental]');
    expect(experimentalBadge?.getAttribute('aria-label')).toBe('Experimental');
    expect(experimentalBadge?.querySelector('.octicon-beaker')).not.toBeNull();
    expect(rendered.ownerDocument.title).toBe('Canonical second · Page Navigation');
    expect(titleLink.hidden).toBe(true);
    expect(titleLink.hasAttribute('href')).toBe(false);
    expect(rendered.ownerDocument.activeElement).toBe(rendered.querySelector('#page-title'));
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-second')).not.toBe(second);
    });
    const renderedSecond = /** @type {HTMLElement} */ (rendered.querySelector('#page-second'));
    expect(renderedSecond.hidden).toBe(false);
    expect(renderedSecond.hasAttribute('data-page-pending')).toBe(false);
    expect(renderedSecond.hasAttribute('aria-busy')).toBe(false);
    expect(rendered.querySelector('#page-title')?.textContent).toBe('Canonical second');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe('Canonical second description');

    pageScroller.scrollTop = 80;
    firstLink.click();
    expect(/** @type {HTMLElement} */ (rendered.querySelector('.title-area [data-page-experimental]')).hidden).toBe(true);

    expect(renderedSecond.hasAttribute('data-page-pending')).toBe(true);
    expect(renderedSecond.childElementCount).toBe(0);
    expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).not.toBeNull();
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).toBeNull();
    });
    const rehydratedFirst = /** @type {HTMLElement} */ (rendered.querySelector('#page-first'));
    expect(/** @type {HTMLDetailsElement | null} */ (rehydratedFirst.querySelector('details'))?.open).toBe(true);
    expect(pageScroller.scrollTop).toBe(320);
    rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  });

  it('does not show the experimental badge when Overview is active', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    rendered.ownerDocument.body.append(rendered);

    try {
      await activatePage(rendered, 'overview');

      expect(rendered.querySelector('#page-title')?.textContent).toBe('Overview');
      const experimentalBadge = /** @type {HTMLElement} */ (rendered.querySelector('.title-area [data-page-experimental]'));
      expect(experimentalBadge.hidden).toBe(true);
      const experimentalIcon = experimentalBadge.querySelector('.octicon-beaker');
      if (!(experimentalIcon instanceof SVGElement)) throw new Error('Expected the experimental icon to render.');
      expect(experimentalIcon.getAttribute('aria-hidden')).toBe('true');
    } finally {
      disposeDashboard(rendered);
      rendered.remove();
    }
  });

  it('replaces a failed asynchronous page render with an accessible error message', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first">First</a>
      <a data-nav-page-id="second" href="#page-second">Second</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first" data-page-pending></section>
        <section class="dashboard-page" id="page-second" data-page-id="second" data-page-pending></section>
      </main>
    `;
    document.body.append(root);
    /** @param {string} pageId */
    const renderPage = (pageId) => {
      if (pageId === 'second') return Promise.reject(new Error('Page rendering failed.'));
      const page = document.createElement('section');
      page.className = 'dashboard-page';
      page.id = `page-${pageId}`;
      page.dataset.pageId = pageId;
      return page;
    };
    try {
      enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      await vi.waitFor(() => {
        expect(root.querySelector('#page-first')?.hasAttribute('data-page-pending')).toBe(false);
      });

      /** @type {HTMLAnchorElement} */ (root.querySelector('[data-nav-page-id="second"]')).click();

      await vi.waitFor(() => {
        expect(root.querySelector('#page-second .empty')?.textContent).toBe('Unable to load this page.');
      });
      const page = /** @type {HTMLElement} */ (root.querySelector('#page-second'));
      expect(page.getAttribute('aria-busy')).toBeNull();
      expect(page.getAttribute('aria-label')).toBeNull();
      expect(page.querySelector('.empty')?.getAttribute('role')).toBe('alert');
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('dispatches initialized route state after an asynchronous page render', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first">First</a>
      <a data-nav-page-id="second" href="#page-second?campaign=optimization">Second</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first" data-page-pending></section>
        <section class="dashboard-page" id="page-second" data-page-id="second" data-page-pending data-route-parameter="campaign"></section>
      </main>
    `;
    document.body.append(root);
    /** @type {((page: HTMLElement) => void) | undefined} */
    let resolveSecond;
    /** @param {string} pageId */
    const renderPage = (pageId) => {
      if (pageId !== 'second') return null;
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    };
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      /** @type {HTMLAnchorElement} */ (root.querySelector('[data-nav-page-id="second"]')).click();
      await vi.waitFor(() => expect(resolveSecond).toBeDefined());

      const page = document.createElement('section');
      page.className = 'dashboard-page';
      page.id = 'page-second';
      page.dataset.pageId = 'second';
      page.dataset.routeParameter = 'campaign';
      const routeView = document.createElement('div');
      routeView.dataset.routeView = '';
      routeView.addEventListener('dashboard-route-change', (event) => {
        if (event instanceof CustomEvent) routeView.dataset.campaign = event.detail.value;
      });
      page.append(routeView);
      resolveSecond?.(page);

      await vi.waitFor(() => {
        expect(root.querySelector('#page-second [data-route-view]')?.getAttribute('data-campaign')).toBe('optimization');
      });
      disposeNavigation();
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps route tabs visible while a sibling view loads', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first?campaign=ambient-context">First</a>
      <a data-nav-page-id="second" href="#page-second?campaign=ambient-context">Second</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first">
          <nav data-route-tabs aria-label="Ambient Context views">
            <a href="#page-first?campaign=ambient-context" aria-current="page">Overview</a>
            <a href="#page-second?campaign=ambient-context">Workflows</a>
            <a href="#page-third?campaign=ambient-context">Runs</a>
          </nav>
          <p>Overview content</p>
        </section>
        <section class="dashboard-page" id="page-second" data-page-id="second" data-page-pending></section>
      </main>
    `;
    document.body.append(root);
    const renderPage = vi.fn((pageId) => pageId === 'second'
      ? new Promise(() => {})
      : null);
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      /** @type {HTMLAnchorElement} */ (root.querySelector('[data-nav-page-id="second"]')).click();

      await vi.waitFor(() => {
        expect(root.querySelector('#page-second .dashboard-view-skeleton')).not.toBeNull();
      });
      const pendingTabs = root.querySelector('#page-second [data-route-tabs]');
      expect(pendingTabs?.textContent?.replace(/\s/g, '')).toBe('OverviewWorkflowsRuns');
      expect(pendingTabs?.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Workflows');
      expect(root.querySelector('#page-second')?.getAttribute('aria-busy')).toBe('true');
      disposeNavigation();
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not navigate when the current route tab is clicked', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first">
          <nav data-route-tabs aria-label="Ambient Context views">
            <a data-nav-page-id="first" href="#page-first?campaign=ambient-context" aria-current="page">Overview</a>
          </nav>
        </section>
      </main>
    `;
    document.body.append(root);
    const renderPage = vi.fn(() => null);
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      const currentTab = /** @type {HTMLAnchorElement} */ (root.querySelector('[aria-current="page"]'));
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      currentTab.dispatchEvent(click);

      expect(click.defaultPrevented).toBe(true);
      expect(renderPage).not.toHaveBeenCalled();
      disposeNavigation();
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('animates query drills forward and browser back navigation backward', () => {
    /** @type {Array<string | undefined>} */
    const directions = [];
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        directions.push(document.documentElement.dataset.navigationDirection);
        callback();
        return { finished: Promise.resolve() };
      })
    });
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first">First</a>
      <a data-card-drill="query" data-nav-page-id="second" href="#page-second?query=items&title=Item">Item</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first"></section>
        <section class="dashboard-page" id="page-second" data-page-id="second"></section>
      </main>
    `;
    document.body.append(root);
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', () => null, 'first');
      /** @type {HTMLAnchorElement} */ (root.querySelector('[data-card-drill="query"]')).click();

      window.history.replaceState(
        { centralAgenticOpsNavigationIndex: 0 },
        '',
        '/#page-first'
      );
      window.dispatchEvent(new PopStateEvent('popstate', {
        state: { centralAgenticOpsNavigationIndex: 0 }
      }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      expect(directions.at(0)).toBe('forward');
      expect(directions.at(-1)).toBe('backward');
      disposeNavigation();
    } finally {
      root.remove();
      Reflect.deleteProperty(document, 'startViewTransition');
      delete document.documentElement.dataset.navigationDirection;
      window.history.replaceState(null, '', '/');
    }
  });

  it('persists page scroll positions for reload and browser history restoration', async () => {
    const createRoot = () => {
      const root = document.createElement('div');
      root.innerHTML = `
        <a data-nav-page-id="first" href="#page-first">First</a>
        <a data-nav-page-id="second" href="#page-second">Second</a>
        <main class="dashboard-prototype">
          <section class="dashboard-page" id="page-first" data-page-id="first"></section>
          <section class="dashboard-page" id="page-second" data-page-id="second"></section>
        </main>
      `;
      document.body.append(root);
      return root;
    };
    const firstRoot = createRoot();
    try {
      const disposeFirstNavigation = enableDashboardPageNavigation(firstRoot, 'Dashboard', () => null, 'first');
      const firstScroller = /** @type {HTMLElement} */ (firstRoot.querySelector('main.dashboard-prototype'));
      firstScroller.scrollTop = 240;
      firstScroller.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => {
        expect(window.history.state?.centralAgenticOpsScrollTop).toBe(240);
      });
      disposeFirstNavigation();
      firstRoot.remove();

      const reloadedRoot = createRoot();
      const disposeReloadedNavigation = enableDashboardPageNavigation(reloadedRoot, 'Dashboard', () => null, 'first');
      const reloadedScroller = /** @type {HTMLElement} */ (reloadedRoot.querySelector('main.dashboard-prototype'));
      expect(reloadedScroller.scrollTop).toBe(240);

      /** @type {HTMLAnchorElement} */ (reloadedRoot.querySelector('[data-nav-page-id="second"]')).click();
      await vi.waitFor(() => {
        expect(reloadedRoot.querySelector('[data-page-id="second"]')?.hasAttribute('hidden')).toBe(false);
      });
      reloadedScroller.scrollTop = 80;
      reloadedScroller.dispatchEvent(new Event('scroll'));
      window.history.replaceState(
        {
          centralAgenticOpsNavigationIndex: 0,
          centralAgenticOpsScrollPageId: 'first',
          centralAgenticOpsScrollTop: 240
        },
        '',
        '/#page-first'
      );
      window.dispatchEvent(new PopStateEvent('popstate', {
        state: {
          centralAgenticOpsNavigationIndex: 0,
          centralAgenticOpsScrollPageId: 'first',
          centralAgenticOpsScrollTop: 240
        }
      }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(reloadedScroller.scrollTop).toBe(240);
      disposeReloadedNavigation();
      reloadedRoot.remove();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('aborts the active page subscription when the dashboard is disposed', async () => {
    /** @type {AbortSignal | undefined} */
    let pageSignal;
    const loadPageSources = vi.fn(async (_pageId, options) => {
      pageSignal = options.signal;
      return {};
    });
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'disposable-dashboard',
          title: 'Disposable Dashboard',
          pages: [{
            id: 'overview',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Overview',
            views: []
          }]
        }
      },
      sources: {},
      loadPageSources
    });

    await vi.waitFor(() => expect(pageSignal).toBeDefined());
    expect(pageSignal?.aborted).toBe(false);

    disposeDashboard(rendered);

    expect(pageSignal?.aborted).toBe(true);
  });

  it('ignores a pending view transition after the dashboard is disposed', () => {
    /** @type {(() => void) | undefined} */
    let transitionUpdate;
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        transitionUpdate = callback;
        return { finished: Promise.resolve() };
      })
    });
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'transition-disposal-dashboard',
          title: 'Transition Disposal Dashboard',
          pages: [
            { id: 'first', kind: /** @type {'custom'} */ ('custom'), title: 'First', views: [] },
            { id: 'second', kind: /** @type {'custom'} */ ('custom'), title: 'Second', views: [] }
          ]
        }
      },
      sources: {}
    });
    document.body.append(rendered);
    try {
      /** @type {HTMLAnchorElement | null} */ (
        rendered.querySelector('[data-nav-page-id="second"]')
      )?.click();
      expect(transitionUpdate).toBeDefined();

      disposeDashboard(rendered);
      transitionUpdate?.();

      expect(rendered.querySelector('[data-page-id="second"]')?.hasAttribute('data-page-pending')).toBe(true);
    } finally {
      rendered.remove();
      Reflect.deleteProperty(document, 'startViewTransition');
      window.history.replaceState(null, '', '/');
    }
  });

  it('removes page navigation handlers when navigation is disposed', async () => {
    /** @type {FrameRequestCallback[]} */
    const animationFrames = [];
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first">First</a>
      <a data-nav-page-id="second" href="#page-second">Second</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first" data-page-pending></section>
        <section class="dashboard-page" id="page-second" data-page-id="second" data-page-pending></section>
      </main>
    `;
    document.body.append(root);
    const renderPage = vi.fn((pageId) => {
      const page = document.createElement('section');
      page.className = 'dashboard-page';
      page.id = `page-${pageId}`;
      page.dataset.pageId = pageId;
      return page;
    });
    try {
      const disposeNavigation = enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      expect(renderPage).toHaveBeenCalledOnce();

      root.querySelector('[data-nav-page-id="second"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      expect(animationFrames).toHaveLength(1);
      disposeNavigation();
      while (animationFrames.length > 0) {
        animationFrames.shift()?.(0);
      }
      window.history.replaceState(null, '', '/#page-second');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      root.querySelector('[data-nav-page-id="second"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

      expect(renderPage).toHaveBeenCalledOnce();
    } finally {
      requestAnimationFrame.mockRestore();
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('uses only declared query drill titles at every navigation depth', () => {
    const knownQueries = new Set(['issue-events']);
    expect(resolveQueryDrillPageTitle(
      new URLSearchParams('query=issue-events&title=Issue+42&issue-id=42'),
      knownQueries
    )).toBe('Issue 42');
    expect(resolveQueryDrillPageTitle(
      new URLSearchParams('query=issue-events&title=Issue+43&issue-id=43'),
      knownQueries
    )).toBe('Issue 43');
    expect(resolveQueryDrillPageTitle(
      new URLSearchParams('query=unknown&title=Untrusted'),
      knownQueries
    )).toBe('');
  });


  it('DLS-SAFE-004 DLS-SAFE-008 DLS-SAFE-009 renders accessible bars, visual chart legends, and rejects unsafe runtime links', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'bar-dashboard',
          title: 'Bar Dashboard',
          pages: [{
            id: 'bars',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'bar-chart',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'bar',
                encoding: {
                  x: { field: 'run-conclusion', type: 'nominal' },
                  y: { field: 'run', type: 'quantitative', aggregate: 'count' },
                  color: { field: 'run-conclusion', type: 'nominal' }
                }
              },
              {
                id: 'unsafe-link',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-conclusion': 'success', 'run-link': { href: 'javascript:alert(1)', label: 'Unsafe' } },
            { run: '2', 'run-conclusion': 'failure', 'run-link': { href: 'https://example.com/runs/2', label: 'Run 2' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelectorAll('[data-chart-widget="bar"] rect[role="img"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="bar"] rect')?.getAttribute('aria-label')).toContain('failure');
    expect(rendered.querySelector('[data-chart-legend="visual"]')?.getAttribute('class')).toContain('chart-legend-bar');
    expect([...rendered.querySelectorAll('[data-chart-legend="visual"] li span')].map((item) => item.textContent)).toEqual(['failure', 'success']);
    expect(rendered.querySelectorAll('.custom-table a')).toHaveLength(1);
    expect(rendered.querySelector('.custom-table a')?.textContent).toBe('2');
  });

  it('DLS-SAFE-004 rejects runtime links with embedded credentials, ftp schemes, and blank labels while preserving safe links', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'credential-link-dashboard',
          title: 'Credential Link Dashboard',
          pages: [{
            id: 'credential-links',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'credential-links-table',
                title: 'Credential Links Table',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              },
              {
                id: 'credential-links-metric',
                title: 'Credential Links Metric',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: {
                  value: { field: 'run', type: 'nominal', aggregate: 'count' },
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-link': { href: 'https://user:secret@example.com/runs/1', label: 'Credentialed Run' } },
            { run: '2', 'run-link': { href: 'ftp://example.com/runs/2', label: 'FTP Run' } },
            { run: '3', 'run-link': { href: 'https://example.com/runs/3', label: '   ' } },
            { run: '4', 'run-link': { href: 'https://example.com/runs/4', label: 'Run 4' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const safeLinks = rendered.querySelectorAll('.custom-table a, .metric-link a');
    expect(safeLinks).toHaveLength(2);
    expect([...safeLinks].map((link) => link.textContent)).toEqual(['4', 'Run 4']);
    expect([...safeLinks].every((link) => !String(link.getAttribute('href')).includes('user:secret@'))).toBe(true);
    expect([...safeLinks].every((link) => String(link.getAttribute('href')).startsWith('https://example.com/runs/4'))).toBe(true);
    expect(rendered.textContent).not.toContain('Credentialed Run');
    expect(rendered.textContent).not.toContain('FTP Run');
    expect(rendered.textContent).toContain('Run 4');
  });

  it('DLS-AGG-008 DLS-VIEW-003 renders report-style aggregate rankings in declared order before applying limit', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'ranked-usage',
          title: 'Ranked usage',
          pages: [{
            id: 'usage',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Usage',
            views: [{
              id: 'repository-usage',
              title: 'Repository usage',
              data: {
                source: 'usage',
                'order-by': [{ field: 'total-aic', direction: 'desc' }],
                limit: 2
              },
              mark: 'table',
              encoding: {
                columns: [
                  { field: 'repository', type: 'nominal' },
                  { field: 'aic', type: 'quantitative', aggregate: 'sum', as: 'total-aic', title: 'Total AIC' }
                ]
              }
            }]
          }]
        }
      },
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { repository: 'charlie', aic: 2 },
            { repository: 'alpha', aic: 4 },
            { repository: 'bravo', aic: 3 },
            { repository: 'charlie', aic: 4 },
            { repository: 'alpha', aic: 1 }
          ],
          metadata: {
            'source-id': 'aic-usage',
            'source-kind': 'report-artifact',
            'as-of': '2026-08-30T12:00:00Z',
            'retrieved-at': '2026-08-30T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const rows = [...rendered.querySelectorAll('.custom-table tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual(['charlie6', 'alpha5']);
    const filter = /** @type {HTMLInputElement} */ (rendered.querySelector('.table-filter input'));
    expect(filter).toBeTruthy();
    expect(filter.closest('label')?.textContent).toContain('Filter Repository usage');
    filter.value = 'alpha';
    filter.dispatchEvent(new Event('input'));
    expect(rows.map((row) => row.hasAttribute('hidden'))).toEqual([true, false]);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 result');
    expect(rendered.querySelector('.freshness')).toBeNull();
  });

  it('renders report-style semantic badges through the generic table presenter', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflow-status',
          title: 'Workflow status',
          pages: [{
            id: 'workflows',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Workflows',
            views: [{
              id: 'workflow-statuses',
              title: 'Workflow statuses',
              data: { source: 'workflows' },
              mark: 'table',
              encoding: {
                columns: [
                  { field: 'workflow', type: 'nominal' },
                  { field: 'workflow-active', type: 'nominal', display: 'active-state' },
                  { field: 'rollout-mode', type: 'nominal', display: 'mode' },
                  { field: 'run-conclusion', type: 'nominal', display: 'status' }
                ]
              }
            }]
          }]
        }
      },
      sources: {
        workflows: {
          source: 'workflows',
          rows: [{
            workflow: 'review',
            'workflow-active': 'true',
            'rollout-mode': 'review',
            'run-conclusion': 'failure'
          }],
          metadata: {
            'source-id': 'deployed-workflows',
            'source-kind': 'report-artifact',
            'as-of': '2026-08-30T12:00:00Z',
            'retrieved-at': '2026-08-30T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelector('.custom-table .status-success')?.textContent).toBe('Active');
    expect(rendered.querySelector('.custom-table .mode-review')?.textContent).toBe('review');
    expect(rendered.querySelector('.custom-table .status-danger')?.textContent).toBe('failure');
  });

  it('routes and reallocates a JSON-selected repository workflow view from a hash query argument', () => {
    window.history.replaceState(null, '', '/#page-repository-detail?repository=octo-org%2Focto-repo');
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repository-detail-dashboard',
          title: 'Repository detail',
          pages: [
            {
              id: 'repository-detail',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository' },
              views: [{
                id: 'repository-workflows',
                title: 'Agentic workflows',
                data: {
                  source: 'workflows',
                  'route-field': 'repository-slug'
                },
                mark: 'table',
                controls: 'static',
                encoding: {
                  columns: [
                    { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                    { field: 'workflow-active', type: 'nominal', title: 'State', display: 'active-state' }
                  ],
                  href: { field: 'workflow-link', type: 'nominal' }
                }
              }]
            },
            {
              id: 'workflow-runtime',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Workflow runtime',
              route: { 'hash-query-parameter': 'workflow' },
              views: []
            }
          ]
        }
      },
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'octo-org', repository: 'octo-repo', 'repository-slug': 'octo-org/octo-repo', workflow: '.github/workflows/review.md', 'workflow-name': 'Review', 'workflow-role': 'standalone', 'workflow-active': 'true', 'observed-at': '2026-08-29T10:00:00Z', 'workflow-link': { relation: 'workflow', 'dashboard-href': '#page-workflow-runtime?workflow=octo-org%2Focto-repo%3A.github%2Fworkflows%2Freview.md', 'dashboard-label': 'Review' } },
            { organization: 'other-org', repository: 'other-repo', 'repository-slug': 'other-org/other-repo', workflow: '.github/workflows/other.md', 'workflow-name': 'Other', 'workflow-role': 'standalone', 'workflow-active': 'true', 'observed-at': '2026-08-29T10:00:00Z', 'workflow-link': { relation: 'workflow', 'dashboard-href': '#page-workflow-runtime?workflow=other-org%2Fother-repo%3A.github%2Fworkflows%2Fother.md', 'dashboard-label': 'Other' } }
          ],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    document.body.append(rendered);

    const repositoryView = rendered.querySelector('[data-view-id="repository-workflows"]');
    expect(repositoryView?.textContent).toContain('Review');
    expect(repositoryView?.textContent).not.toContain('Other');
    expect(rendered.querySelector('#page-title')?.textContent).toBe('octo-org/octo-repo');
    expect(rendered.ownerDocument.title).toBe('octo-org/octo-repo · Repository detail');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('octo-org/octo-repo');
    expect(repositoryView?.querySelector('tbody a')?.getAttribute('href')).toBe('#page-workflow-runtime?workflow=octo-org%2Focto-repo%3A.github%2Fworkflows%2Freview.md');
    expect(repositoryView?.querySelector('tbody a')?.getAttribute('target')).toBeNull();

    rendered.remove();
    window.history.replaceState(null, '', '/');
  });
});
