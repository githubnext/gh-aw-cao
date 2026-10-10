import { afterEach, describe, expect, it, vi } from 'vitest';
import { tileTreemap } from '../../src/components/treemap-layout.js';
import { renderChartWidget } from '../../src/components/chart-elements.js';
import { renderDataView } from '../../src/components/data-view.js';
import { renderDashboard, disposeDashboard } from '../../src/presenter.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { processDataRequest } from '../../src/data-worker.js';
import { BUILT_IN_PAGE_DATA_STATE_KEYS } from '../../src/specification.js';
import contract from '../fixtures/treemap-contract.json' with { type: 'json' };

const bounds = { x: 2, y: 3, width: 100, height: 60 };
const methods = /** @type {const} */ (['squarify', 'binary', 'slicedice']);
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'treemap-fixture', 'source-kind': 'fixture',
  'as-of': '2026-10-10T00:00:00Z', 'retrieved-at': '2026-10-10T00:00:00Z',
  availability: 'available', completeness: 'complete', freshness: 'fresh'
};
const page = contract.dashboard.pages[0];
const view = page.views[0];

/** @param {number | null} value @param {string} [name] */
function point(value, name = 'Worker') {
  return { x: name, y: value, color: null };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('treemap geometry', () => {
  it.each(methods)('%s tiles without overlap and preserves exact proportional areas', (method) => {
    for (const values of [[60, 30, 10], [1], [1, 1, 1, 1, 1], [1000, 1, 1, 1], Array.from({ length: 100 }, (_, index) => 100 - index)]) {
      const tiles = values.map((value, index) => ({ index, value }));
      const rectangles = tileTreemap(tiles, bounds, { method });
      expect(rectangles).toHaveLength(values.length);
      expect(tileTreemap(tiles, bounds, { method })).toEqual(rectangles);
      const total = values.reduce((sum, value) => sum + value, 0);
      for (const [index, rectangle] of rectangles.entries()) {
        expect(rectangle.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(rectangle.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
        expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
        expect(rectangle.width * rectangle.height).toBeCloseTo(6000 * values[rectangle.index] / total, 7);
        for (const other of rectangles.slice(index + 1)) {
          const overlapX = Math.min(rectangle.x + rectangle.width, other.x + other.width) - Math.max(rectangle.x, other.x);
          const overlapY = Math.min(rectangle.y + rectangle.height, other.y + other.height) - Math.max(rectangle.y, other.y);
          expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it('changes squarify aspect ratio and alternates slicedice orientation by depth', () => {
    const tiles = [6, 4, 3, 2, 1].map((value, index) => ({ index, value }));
    expect(tileTreemap(tiles, bounds, { ratio: 1 })).not.toEqual(tileTreemap(tiles, bounds, { ratio: 5 }));
    const first = tileTreemap(tiles, bounds, { method: 'slicedice' }, 0);
    const nested = tileTreemap(tiles, bounds, { method: 'slicedice' }, 1);
    expect(first[0].height).toBe(60);
    expect(nested[0].width).toBe(100);
  });

  it('normalizes extreme values without overflowing the total', () => {
    const rectangles = tileTreemap([{ index: 0, value: 1e308 }, { index: 1, value: 1e308 }], bounds);
    expect(rectangles.every((tile) => Object.values(tile).every(Number.isFinite))).toBe(true);
    expect(rectangles[0].width * rectangles[0].height).toBeCloseTo(3000);
    expect(() => tileTreemap([{ index: 0, value: -1 }], bounds)).toThrow(RangeError);
  });

  it.each(methods)('%s preserves positive geometry near the accepted dynamic-range boundary', (method) => {
    for (let length = 2; length <= 100; length++) {
      const tiles = Array.from({ length }, (_, index) => ({
        index, value: index === 0 ? 1 : Number.EPSILON * (1 + index % 3)
      }));
      const rectangles = tileTreemap(tiles, bounds, { method });
      expect(rectangles).toHaveLength(length);
      for (const rectangle of rectangles) {
        expect([rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite)).toBe(true);
        expect(rectangle.width).toBeGreaterThan(0);
        expect(rectangle.height).toBeGreaterThan(0);
      }
    }
  });
});

describe('declarative treemap contract', () => {
  it('validates the example and rejects unsupported options and encodings', () => {
    expect(validateDashboardDocument(JSON.stringify(contract)).ok).toBe(true);
    /** @type {Array<[string, unknown]>} */
    const mutations = [
      ['data.limit', undefined], ['data.limit', 101], ['treemap.method', 'random'],
      ['treemap.ratio', 0.5], ['treemap.padding', 11], ['treemap.extra', true],
      ['encoding.x.type', 'temporal'], ['encoding.y.type', 'nominal'],
      ['encoding.y.aggregate', 'sum'], ['encoding.color.type', 'quantitative'],
      ['encoding.section.type', 'quantitative'], ['encoding.weight', { field: 'run-count' }]
    ];
    for (const [path, value] of mutations) {
      const modified = structuredClone(contract);
      let target = /** @type {Record<string, unknown>} */ (modified.dashboard.pages[0].views[0]);
      const keys = path.split('.');
      for (const key of keys.slice(0, -1)) target = /** @type {Record<string, unknown>} */ (target[key]);
      target[keys.at(-1) ?? ''] = value;
      expect(validateDashboardDocument(JSON.stringify(modified)).ok, path).toBe(false);
    }
    const wrongChart = structuredClone(contract);
    wrongChart.dashboard.pages[0].views[0].chart = 'bar';
    expect(validateDashboardDocument(JSON.stringify(wrongChart)).ok).toBe(false);
    const flat = structuredClone(contract);
    const flatView = /** @type {Record<string, unknown>} */ (flat.dashboard.pages[0].views[0].encoding);
    delete flatView.section;
    expect(validateDashboardDocument(JSON.stringify(flat)).ok).toBe(true);
    flat.dashboard.pages[0].views[0].encoding.y = { ...flat.dashboard.pages[0].views[0].encoding.y, ...{ aggregate: 'mean' } };
    expect(validateDashboardDocument(JSON.stringify(flat)).ok).toBe(false);
  });

  it('executes aggregation, ordering and limits only through the production worker boundary', () => {
    const payload = compileDashboardViewPayloadQueries(page, page.id, { queries: contract.dashboard.queries });
    const rows = [
      { repository: 'alpha', workflow: 'a.md', run: '1', 'run-conclusion': 'success' },
      { repository: 'alpha', workflow: 'a.md', run: '2', 'run-conclusion': 'success' },
      { repository: 'beta', workflow: 'b.md', run: '3', 'run-conclusion': 'failure' }
    ];
    const execute = () => /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: payload.queries, sourceNames: payload.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }));
    const result = execute()[payload.aliases[0]];
    expect(result.rows).toEqual([
      { repository: 'alpha', workflow: 'a.md', 'run-conclusion': 'success', 'run-count': 2 },
      { repository: 'beta', workflow: 'b.md', 'run-conclusion': 'failure', 'run-count': 1 }
    ]);
    expect(payload.queries.at(-1)).toMatchObject({ name: payload.aliases[0], limit: 100 });
    rows.push({ repository: 'beta', workflow: 'b.md', run: '4', 'run-conclusion': 'failure' });
    expect(execute()[payload.aliases[0]].rows[1]['run-count']).toBe(2);
    rows.push({ repository: 'beta', workflow: 'b.md', run: '5', 'run-conclusion': 'failure' });
    const limitedPage = structuredClone(page);
    limitedPage.views[0].data.limit = 1;
    limitedPage.views[0].data = { ...limitedPage.views[0].data, ...{ 'order-by': [{ field: 'run-count', direction: 'desc' }] } };
    const limited = compileDashboardViewPayloadQueries(limitedPage, page.id, { queries: contract.dashboard.queries });
    expect(/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: limited.queries, sourceNames: limited.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }))[limited.aliases[0]].rows).toEqual([
      { repository: 'beta', workflow: 'b.md', 'run-conclusion': 'failure', 'run-count': 3 }
    ]);
    limitedPage.views[0].data = { ...limitedPage.views[0].data, ...{
      'query-context': false, 'order-by': [{ field: 'run-count', direction: 'asc' }]
    } };
    const isolated = compileDashboardViewPayloadQueries(limitedPage, page.id, { queries: contract.dashboard.queries });
    expect(isolated.aliases).toHaveLength(1);
    expect(/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: isolated.queries, sourceNames: isolated.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }))[isolated.aliases[0]].rows).toEqual([
      { repository: 'alpha', workflow: 'a.md', 'run-conclusion': 'success', 'run-count': 2 }
    ]);
    const missing = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: payload.queries, sourceNames: payload.aliases, sources: {}
    }))[payload.aliases[0]];
    expect(missing.metadata.availability).toBe('unavailable');
  });

  it('enforces the same treemap contract in built-in page definitions', () => {
    const builtIn = {
      ...contract,
      dashboard: {
        ...contract.dashboard,
        pages: [{
          id: 'experiments', kind: 'built-in', page: 'experiments',
          definition: { 'data-state': Object.fromEntries(BUILT_IN_PAGE_DATA_STATE_KEYS.map((key) => [key, true])), views: [
            { id: 'experiment-list', mark: 'table', data: { source: 'experiments' },
              encoding: { columns: [{ field: 'experiment' }] } },
            structuredClone(view)
          ] }
        }]
      }
    };
    expect(validateDashboardDocument(JSON.stringify(builtIn)).ok).toBe(true);
    const builtInPage = builtIn.dashboard.pages[0];
    for (const invalidView of [
      { ...view, data: { source: 'workflow-footprint' } },
      { ...view, treemap: { method: 'random' } },
      { ...view, treemap: { extra: true } },
      { ...view, encoding: { ...view.encoding, y: { field: 'run-count', aggregate: 'sum' } } }
    ]) {
      const invalid = { ...builtIn, dashboard: { ...builtIn.dashboard, pages: [{
        ...builtInPage, definition: { ...builtInPage.definition, views: [builtInPage.definition.views[0], invalidView] }
      }] } };
      expect(validateDashboardDocument(JSON.stringify(invalid)).ok).toBe(false);
    }
  });

  it('never invokes presenter-side aggregation, ordering, or limiting', () => {
    const prepare = vi.fn(() => { throw new Error('Main-thread query is forbidden'); });
    const chart = renderDataView('chart', {
      pageId: 'footprint', title: view.title, view, sourceName: 'workflow-footprint', metadata,
      rows: [{ workflow: 'one', repository: 'alpha', 'run-count': 3, 'run-conclusion': 'success' }],
      contextDetails: [], headingTag: 'h3', prepareTableRows: prepare,
      buildChartPoints: prepare, prepareChartPoints: prepare, toText: String
    });
    expect(chart?.querySelectorAll('[data-treemap-leaf]')).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(['view', 'encoding'])('composes %s facets with worker-prepared treemaps and global limits', (syntax) => {
    const facet = { field: 'run-conclusion', title: 'Conclusion' };
    const facetedView = {
      ...view, columns: 2,
      ...(syntax === 'view' ? { facet } : { encoding: { ...view.encoding, facet } }),
      data: { ...view.data, limit: 3, 'order-by': [{ field: 'run-count', direction: 'desc' }] }
    };
    const facetedPage = { ...page, views: [facetedView] };
    const model = { ...contract, dashboard: { ...contract.dashboard, pages: [facetedPage] } };
    expect(validateDashboardDocument(JSON.stringify(model)).ok).toBe(true);
    const payload = compileDashboardViewPayloadQueries(facetedPage, page.id, { queries: contract.dashboard.queries });
    expect(payload.queries.at(-1)).toMatchObject({ facet: { field: 'run-conclusion', as: 'facet-rows' } });
    const rows = [
      { repository: 'alpha', workflow: 'a.md', run: '1', 'run-conclusion': 'success' },
      { repository: 'alpha', workflow: 'a.md', run: '2', 'run-conclusion': 'success' },
      { repository: 'beta', workflow: 'b.md', run: '3', 'run-conclusion': 'failure' },
      { repository: 'gamma', workflow: 'c.md', run: '4', 'run-conclusion': 'success' }
    ];
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: payload.queries, sourceNames: payload.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }))[payload.aliases[0]];
    expect(result.rows).toMatchObject([
      { 'facet-field': 'success', 'facet-rows': [{ workflow: 'a.md', 'run-count': 2 }, { workflow: 'c.md', 'run-count': 1 }] },
      { 'facet-field': 'failure', 'facet-rows': [{ workflow: 'b.md', 'run-count': 1 }] }
    ]);
    const prepare = vi.fn(() => { throw new Error('Main-thread query is forbidden'); });
    const chart = renderDataView('chart', {
      pageId: page.id, title: view.title, view: facetedView, sourceName: result.source,
      rows: result.rows, metadata: result.metadata, contextDetails: [], headingTag: 'h3',
      prepareTableRows: prepare, buildChartPoints: prepare, prepareChartPoints: prepare, toText: String
    });
    expect(chart?.querySelectorAll('figure')).toHaveLength(2);
    expect(chart?.querySelectorAll('[data-treemap-leaf]')).toHaveLength(3);
    expect(prepare).not.toHaveBeenCalled();
    const limitedPage = { ...facetedPage, views: [{ ...facetedView, data: { ...facetedView.data, limit: 1 } }] };
    const limited = compileDashboardViewPayloadQueries(limitedPage, page.id, {
      queries: contract.dashboard.queries, queryContext: { orderBy: [{ field: 'run-count', direction: 'asc' }] }
    });
    const limitedResult = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: limited.queries, sourceNames: limited.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }))[limited.aliases[0]];
    expect(limitedResult.rows).toMatchObject([{ 'facet-field': 'failure', 'facet-rows': [{ workflow: 'b.md', 'run-count': 1 }] }]);
    const isolated = compileDashboardViewPayloadQueries({
      ...limitedPage, views: [{ ...limitedPage.views[0], data: { ...limitedPage.views[0].data, 'query-context': false } }]
    }, page.id, { queries: contract.dashboard.queries, queryContext: { orderBy: [{ field: 'run-count', direction: 'asc' }] } });
    const isolatedResult = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: isolated.queries, sourceNames: isolated.aliases,
      sources: { runs: { source: 'runs', rows, metadata } }
    }))[isolated.aliases[0]];
    expect(isolatedResult.rows).toMatchObject([{ 'facet-field': 'success', 'facet-rows': [{ workflow: 'a.md', 'run-count': 2 }] }]);
  });

  it('updates the active chart from abort-scoped source subscriptions', async () => {
    /** @type {((sources: Record<string, import('../../src/presenter.js').LogicalSourceInput>) => void) | undefined} */
    let update;
    /** @type {AbortSignal | undefined} */
    let signal;
    const root = renderDashboard({
      document: { languageVersion: '0.1.0', dashboard: {
        ...contract.dashboard, pages: [{ ...page, kind: 'custom' }]
      } }, sources: {},
      loadPageSources: async (_pageId, options) => {
        update = options.onUpdate;
        signal = options.signal;
        return { 'workflow-footprint': { source: 'workflow-footprint', metadata, rows: [
          { workflow: 'one', repository: 'alpha', 'run-count': 3, 'run-conclusion': 'success' }
        ] } };
      }
    });
    document.body.append(root);
    await vi.waitFor(() => expect(root.querySelector('[data-treemap-value="3"]')).not.toBeNull());
    update?.({ 'workflow-footprint': { source: 'workflow-footprint', metadata, rows: [
      { workflow: 'one', repository: 'alpha', 'run-count': 9, 'run-conclusion': 'success' }
    ] } });
    await vi.waitFor(() => expect(root.querySelector('[data-treemap-value="9"]')).not.toBeNull());
    disposeDashboard(root);
    expect(signal?.aborted).toBe(true);
  });
});

describe('treemap accessible rendering', () => {
  it('renders one leaf, labels, grouping and safe keyboard-operable links', () => {
    const chart = renderChartWidget('treemap', [
      { ...point(6, 'Doctor'), section: 'alpha', link: { href: 'https://github.com/githubnext/gh-aw-cao', label: 'Doctor' } },
      { ...point(3, 'Audit'), section: 'alpha', color: 'failure' },
      { ...point(1, 'Activity'), section: 'beta' }
    ], [], null, 'Runs');
    expect(chart.querySelectorAll('[data-treemap-group]')).toHaveLength(2);
    expect(chart.querySelectorAll('[data-treemap-leaf]')).toHaveLength(3);
    const link = chart.querySelector('a');
    expect(link?.getAttribute('aria-label')).toBe('alpha / Doctor: Runs 6');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(chart.querySelector('[data-treemap-leaf="Audit"]')?.getAttribute('tabindex')).toBe('0');
    const tooltip = chart.querySelector(`[id="${link?.getAttribute('aria-describedby')}"]`);
    expect(tooltip?.getAttribute('role')).toBe('tooltip');
    expect(tooltip?.textContent).toContain('DoctoralphaRuns: 6');
    expect(chart.querySelector('[data-treemap-leaf="Audit"]')?.tagName).toBe('BUTTON');
    link?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(link?.parentElement?.classList.contains('treemap-tooltip-dismissed')).toBe(true);
    link?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(link?.parentElement?.classList.contains('treemap-tooltip-dismissed')).toBe(false);
    expect(renderChartWidget('treemap', [point(1)], []).querySelectorAll('[data-treemap-leaf]')).toHaveLength(1);
  });

  it('reports missing, zero, invalid and oversized data without misleading rectangles', () => {
    for (const points of [[point(null), point(0)], [point(-1)], [point(Number.NaN)], [point(Infinity)], [point(1e308), point(1e-308)], Array.from({ length: 101 }, () => point(1))]) {
      const chart = renderChartWidget('treemap', points, []);
      expect(chart.querySelectorAll('[data-treemap-leaf]')).toHaveLength(0);
      expect(chart.querySelector('[role="status"]')).not.toBeNull();
    }
    const partial = renderChartWidget('treemap', [point(3), point(null), point(0)], []);
    expect(partial.querySelectorAll('[data-treemap-leaf]')).toHaveLength(1);
    expect(partial.textContent).toContain('2 missing or zero-valued observations');
  });

  it('preserves readable tooltips for tiny tiles and releases tracking on detachment', async () => {
    const chart = renderChartWidget('treemap', [point(1000, 'Large'), point(1, 'Small label that does not fit')], []);
    document.body.append(chart);
    const tiny = chart.querySelector('.treemap-leaf-small');
    expect(tiny).not.toBeNull();
    const tooltip = chart.querySelector(`[id="${tiny?.getAttribute('aria-describedby')}"]`);
    expect(tooltip?.textContent).toContain('Small label that does not fit');
    expect(tooltip?.textContent).toContain('Total: 1');
    const remove = vi.spyOn(window, 'removeEventListener');
    tiny?.parentElement?.dispatchEvent(new Event('pointerenter'));
    chart.remove();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('resize', expect.any(Function)));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });
});
