// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import contract from '../fixtures/chart-layer-contract.json' with { type: 'json' };
import { resolveChartLayers } from '../../src/chart-layer-specification.js';
import { renderLayeredChartWidget } from '../../src/components/chart-elements.js';
import { renderDataView } from '../../src/components/data-view.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { disposeDashboard, renderDashboard } from '../../src/presenter.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'layers', 'source-kind': 'fixture',
  'as-of': '2026-10-01T00:00:00Z', 'retrieved-at': '2026-10-01T00:00:00Z',
  completeness: 'complete', freshness: 'fresh', availability: 'available'
};
const page = contract.dashboard.pages[0];
const view = page.views[0];
/** @param {Record<string, unknown>} override */
function validate(override) {
  const document = structuredClone(contract);
  Object.assign(document.dashboard.pages[0].views[0], override);
  return validateDashboardDocument(JSON.stringify(document));
}
/** @param {string} x @param {number | null} y @param {string} [color] */
const point = (x, y, color = 'Observed') => ({ x, y, color });
/** @param {string} chart @param {import('../../src/components/chart-elements.js').ChartPointLike[]} points */
const layer = (chart, points) => ({ chart, points, unit: null, label: chart });

describe('declarative chart layering', () => {
  it('inherits encodings through nested groups without mutating the document', () => {
    const before = JSON.stringify(view);
    const resolved = resolveChartLayers(view);
    expect(resolved.map((item) => item.chart)).toEqual(['area', 'line', 'dot', 'rule']);
    expect(resolved[2].encoding).toEqual(view.encoding);
    expect(resolved[3].encoding.y).toMatchObject({ field: 'estimated-usd' });
    expect(JSON.stringify(view)).toBe(before);
    expect(validate({})).toMatchObject({ ok: true });
  });

  it.each([
    { layer: [] }, { layer: 'line' }, { chart: 'line' }, { resolve: { scale: { x: 'independent' } } },
    { data: { source: 'layer-observations', limit: 5 } },
    { data: { source: 'layer-observations', 'order-by': [{ field: 'aic' }] } },
    { layer: [{ chart: 'pie' }] }, { layer: [{ chart: 'scatter' }] },
    { layer: [{ chart: 'dot', data: { source: 'runs' } }] },
    { layer: [{ chart: 'line', encoding: { row: { field: 'workflow' } } }] },
    { layer: [{ chart: 'bar', encoding: { x: { field: 'aic', type: 'quantitative' } } }] },
    { layer: [{ chart: 'line', encoding: { y: [{ field: 'aic' }] } }] },
    { layer: [{ chart: 'line', encoding: { y: { field: 'aic', aggregate: 'mean' } } }] },
    { layer: [{ chart: 'line', encoding: { x: { field: 'observed-at', 'time-unit': 'day' } } }] },
    { layer: [{ chart: 'line', encoding: { y: { field: 'not-a-field' } } }] },
    { layer: [{ chart: 'dot', layer: [{ chart: 'line' }] }] },
    { layer: Array.from({ length: 9 }, () => ({ chart: 'dot' })) },
    { layer: [{ layer: [{ layer: [{ layer: [{ layer: [{ chart: 'line' }] }] }] }] }] }
  ])('rejects invalid or unsupported layer syntax: %j', (override) => {
    expect(validate(override)).toMatchObject({ ok: false });
  });

  it('requires compatible shared x types and units and accepts independent y scales', () => {
    expect(validate({ layer: [
      { chart: 'bar', encoding: { x: { field: 'observed-at', type: 'ordinal' } } },
      { chart: 'line' }
    ] })).toMatchObject({ ok: false });
    const layer = [{ chart: 'line' }, {
      chart: 'dot', encoding: { y: { field: 'estimated-usd', type: 'quantitative', unit: 'usd' } }
    }];
    expect(validate({ layer })).toMatchObject({ ok: false });
    expect(validate({ layer, resolve: { scale: { y: 'independent' } } })).toMatchObject({ ok: true });
    expect(validate({ mark: 'metric' })).toMatchObject({ ok: false });
  });

  it('rejects duplicate keys in layer mappings and inherited field definitions', () => {
    const yaml = `language-version: "0.1.0"
dashboard:
  id: layers
  title: Layers
  pages:
    - id: layers
      kind: custom
      views:
        - id: observations
          mark: chart
          data: { source: usage }
          encoding:
            x: { field: observed-at, type: temporal }
            y: { field: aic, type: quantitative }
          layer:
            - chart: line
              chart: dot
              encoding:
                y: { field: aic, field: estimated-usd }
`;
    const result = validateDashboardDocument(yaml);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DLS-E004', path: expect.stringContaining('layer[0].chart') }),
      expect.objectContaining({ code: 'DLS-E004', path: expect.stringContaining('layer[0].encoding.y.field') })
    ]));
  });

  it('retains accessible safe SVG links and rejects unbounded bar output', () => {
    const widget = renderLayeredChartWidget([layer('dot', [{
      ...point('2026-10-01', 2),
      link: { href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42', label: 'Run 42' }
    }])], true);
    const link = widget.querySelector('a');
    expect(link?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(link?.getAttribute('aria-label')).toContain('Run 42');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.querySelector('g')?.hasAttribute('tabindex')).toBe(false);
    const large = renderLayeredChartWidget([layer('bar', Array.from({ length: 2001 }, () => point('a', 2)))], false);
    expect(large.querySelector('svg')).toBeNull();
    expect(large.textContent).toContain('at most 2000');
  });

  it('unions domains across layers and renders marks in authored order in one SVG', () => {
    const widget = renderLayeredChartWidget([
      layer('line', [point('2026-10-01', 2), point('2026-10-03', 10)]),
      layer('dot', [point('2026-10-02', 10), point('2026-10-03', -10)]),
      layer('rule', [point('', -5, 'Reference')])
    ], true);
    expect(widget.querySelectorAll('svg')).toHaveLength(1);
    expect(widget.querySelectorAll('.line-chart-y-axis')).toHaveLength(1);
    expect([...widget.querySelectorAll('[data-chart-layer-type]')].map((node) => node.getAttribute('data-chart-layer-type')))
      .toEqual(['line', 'dot', 'rule']);
    const line = widget.querySelector('polyline')?.getAttribute('points')?.split(' ').map((point) => point.split(',').map(Number));
    const dot = widget.querySelector('circle');
    expect(Number(dot?.getAttribute('cy'))).toBeCloseTo(line?.[1][1] ?? NaN);
    expect(Number(dot?.getAttribute('cx'))).toBeCloseTo(((line?.[0][0] ?? NaN) + (line?.[1][0] ?? NaN)) / 2);
    expect(widget.querySelector('.dot-chart-reference')?.getAttribute('y1')).toBe('29.5');
    expect(widget.querySelector('svg')?.getAttribute('aria-label')).toContain('3 layers');
  });

  it('uses proportional temporal positions, independent layer domains, and explicit scale labels', () => {
    const widget = renderLayeredChartWidget([
      layer('line', [point('2026-10-01', 1), point('2026-10-11', 10)]),
      layer('dot', [point('2026-10-02', 100), point('2026-10-11', 1000)])
    ], true, true);
    const coordinates = widget.querySelector('polyline')?.getAttribute('points')?.split(' ').map((point) => point.split(',').map(Number));
    const dots = widget.querySelectorAll('circle');
    expect(Number(dots[0].getAttribute('cx'))).toBeCloseTo(
      (coordinates?.[0][0] ?? NaN) + ((coordinates?.[1][0] ?? NaN) - (coordinates?.[0][0] ?? NaN)) / 10
    );
    expect(Number(dots[1].getAttribute('cy'))).toBe(coordinates?.[1][1]);
    expect(widget.querySelector('.layer-chart-scale-key')?.textContent).toContain('dot: 0 – 1000');
    expect(widget.querySelector('.line-chart-y-labels')).toBeNull();
  });

  it('includes stacked area totals in the shared domain and preserves observation gaps', () => {
    const widget = renderLayeredChartWidget([
      layer('area', [point('a', 4, 'first'), point('b', null, 'first'), point('c', 3, 'first'),
        point('a', 6, 'second'), point('b', 3, 'second'), point('c', 7, 'second')]),
      layer('line', [point('a', 10), point('b', null), point('c', 10)])
    ], false);
    expect(widget.querySelector('path.area-chart-area')?.getAttribute('d')?.match(/M /g)).toHaveLength(2);
    expect(widget.querySelector('.line-chart-y-labels')?.textContent).toBe('1050');
    expect(widget.querySelectorAll('path.line-chart-series')).toHaveLength(1);
  });

  it('stacks negative area observations below zero without clipping them or changing other layers', () => {
    const widget = renderLayeredChartWidget([
      layer('area', [point('a', -4, 'first'), point('b', -4, 'first'),
        point('a', -6, 'second'), point('b', -6, 'second')]),
      layer('bar', [point('a', -10), point('b', 2)])
    ], false);
    expect([...widget.querySelectorAll('.line-chart-y-labels span')].map((node) => node.textContent)).toEqual(['2', '-4', '-10']);
    const area = widget.querySelector('path[data-chart-series="second"]')?.getAttribute('d');
    expect(area).toContain('38');
    expect(widget.querySelector('rect.bar-chart-bar')?.getAttribute('y')).not.toBe('38');
  });

  it('supports empty layers, singleton marks, categorical bars and horizontal-rule-only plots', () => {
    const widget = renderLayeredChartWidget([
      layer('area', []), layer('bar', [point('a', -2)]), layer('dot', [])
    ], false);
    expect(widget.querySelectorAll('[data-chart-layer]')).toHaveLength(3);
    expect(Number(widget.querySelector('rect.bar-chart-bar')?.getAttribute('height'))).toBeGreaterThan(0);
    expect(renderLayeredChartWidget([layer('rule', [point('', 2)])], false).querySelectorAll('.dot-chart-reference')).toHaveLength(1);
    expect(renderLayeredChartWidget([layer('line', [point('a', null)])], false).querySelector('svg')).toBeNull();
  });

  it('resolves the contract through the production worker/query boundary and renders its payload', () => {
    const compiled = compileDashboardViewPayloadQueries(page, page.id, { queries: contract.dashboard.queries });
    expect(compiled.aliases).toHaveLength(1);
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases,
      sources: {
        usage: { source: 'usage', metadata, rows: [
          { 'observed-at': '2026-10-03', aic: 10, 'estimated-usd': 5 },
          { 'observed-at': '2026-10-01', aic: 2, 'estimated-usd': 5 }
        ] }
      }
    }));
    const payload = result[compiled.aliases[0]];
    expect(payload.metadata.availability).toBe('available');
    expect(payload.rows.map((row) => row.aic)).toEqual([2, 10]);
    const render = (rows = payload.rows, sourceMetadata = metadata) => renderDataView('chart', {
      pageId: page.id, title: view.title, view, sourceName: view.data.source,
      rows, metadata: sourceMetadata, contextDetails: [], headingTag: 'h3', toText: String,
      prepareTableRows: () => { throw new Error('UI must not query rows'); },
      buildChartPoints: () => { throw new Error('UI must not aggregate rows'); },
      prepareChartPoints: () => { throw new Error('UI must not order rows'); }
    });
    const rendered = render();
    expect(rendered?.querySelectorAll('[data-chart-layer]')).toHaveLength(4);
    expect(rendered?.querySelectorAll('.chart-legend li')).toHaveLength(2);
    expect(render([], { ...metadata, availability: 'empty' })?.querySelector('svg')).toBeNull();
    expect(render(payload.rows, { ...metadata, availability: 'unavailable' })?.textContent).toContain('Data is unavailable');
    const unavailable = /** @type {typeof result} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases, sources: {}
    }));
    expect(unavailable[compiled.aliases[0]].metadata.availability).toBe('unavailable');
  });

  it('reacts to fresh worker payloads and stops updates after its subscription is aborted', async () => {
    const compiled = compileDashboardViewPayloadQueries(page, page.id, { queries: contract.dashboard.queries });
    /** @param {number} value */
    const snapshot = (value) => /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases,
      sources: { usage: { source: 'usage', metadata, rows: [
        { 'observed-at': '2026-10-01', aic: value, 'estimated-usd': 5 },
        { 'observed-at': '2026-10-03', aic: value + 1, 'estimated-usd': 5 }
      ] } }
    }));
    /** @type {NonNullable<Parameters<typeof renderDashboard>[0]['loadPageSources']>} */
    const loadPageSources = vi.fn(() => { throw new Error('Expected a view-scoped subscription.'); });
    /** @type {Parameters<NonNullable<typeof loadPageSources.subscribeViewSources>>[3] | undefined} */
    let subscription;
    loadPageSources.subscribeViewSources = vi.fn(async (_pageId, _viewId, _names, options) => {
      subscription = options;
      return snapshot(2);
    });
    const root = renderDashboard({
      document: { languageVersion: '0.1.0', dashboard: {
        ...structuredClone(contract.dashboard),
        pages: [{ ...structuredClone(page), kind: 'custom' }]
      } },
      sources: {}, loadPageSources
    });
    document.body.append(root);
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('[data-chart-layer]')).toHaveLength(4));
      expect(loadPageSources).not.toHaveBeenCalled();
      expect(root.querySelector('[data-chart-layer-type="dot"] [aria-label]')?.getAttribute('aria-label')).toContain(': 2,');
      subscription?.onUpdate(snapshot(20));
      expect(root.querySelector('[data-chart-layer-type="dot"] [aria-label]')?.getAttribute('aria-label')).toContain(': 20,');
      expect(root.querySelectorAll('.layer-chart-widget svg')).toHaveLength(1);
      disposeDashboard(root);
      expect(subscription?.signal.aborted).toBe(true);
      subscription?.onUpdate(snapshot(99));
      expect(root.querySelector('[data-chart-layer-type="dot"] [aria-label]')?.getAttribute('aria-label')).toContain(': 20,');
    } finally {
      disposeDashboard(root);
      root.remove();
    }
  });
});
