import { afterEach, describe, expect, it, vi } from 'vitest';
import contract from '../fixtures/chart-facet-contract.json' with { type: 'json' };
import { validateDashboardDocument } from '../../src/validator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { renderDataView } from '../../src/components/data-view.js';
import { buildChartPoints, prepareChartPoints, prepareTableRows, toViewText } from '../../src/components/view-data.js';
import { chartStyles } from '../../src/styles-charts.js';
import { tidy } from '../../src/data-operations.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'facet-evidence',
  'source-kind': 'fixture',
  'as-of': '2026-10-01T00:00:00Z',
  'retrieved-at': '2026-10-01T00:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};
const observations = [
  { engine: 'copilot', workflow: 'worker', aic: 2, organization: 'githubnext', repository: 'one' },
  { engine: 'claude', workflow: 'worker', aic: 9, organization: 'githubnext', repository: 'two' },
  { engine: 'copilot', workflow: 'worker', aic: 3, organization: 'githubnext', repository: 'one' },
  { engine: 'claude', workflow: 'review', aic: 7, organization: 'githubnext', repository: 'two' }
];
const baseView = contract.dashboard.pages[0].views[0];

/** @param {Record<string, unknown>} [view] @param {Array<Record<string, unknown>>} [rows] @param {Record<string, unknown>} [options] */
function execute(view = baseView, rows = observations, options = {}) {
  const compiled = compileDashboardViewPayloadQueries({ views: [view] }, 'facets', options);
  const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries: compiled.queries,
    sourceNames: compiled.aliases,
    sources: { usage: { source: 'usage', rows, metadata } }
  }));
  return { compiled, source: sources[compiled.aliases[0]] };
}

/** @param {Record<string, unknown>} view @param {import('../../src/presenter.js').LogicalSourceInput} source */
function render(view, source) {
  return /** @type {HTMLElement} */ (renderDataView('chart', {
    pageId: 'facets',
    title: 'Cost by engine',
    view,
    sourceName: source.source,
    rows: source.rows,
    metadata: source.metadata,
    contextDetails: [],
    headingTag: 'h2',
    buildChartPoints,
    prepareChartPoints,
    prepareTableRows,
    toText: toViewText
  }));
}

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('chart facet validation', () => {
  /** @param {Record<string, unknown>} overrides */
  const validate = (overrides) => {
    const fixture = structuredClone(contract);
    Object.assign(fixture.dashboard.pages[0].views[0], overrides);
    return validateDashboardDocument(JSON.stringify(fixture));
  };
  it('accepts the contract and every categorical operator/channel spelling', () => {
    expect(validate({})).toMatchObject({ ok: true });
    for (const channels of [
      { facet: { field: 'engine', type: 'nominal' } },
      { row: { field: 'engine' } },
      { column: { field: 'engine' } },
      { row: { field: 'engine' }, column: { field: 'repository' } }
    ]) {
      expect(validate({ facet: undefined, columns: undefined, encoding: { ...baseView.encoding, ...channels } })).toMatchObject({ ok: true });
    }
    expect(validate({ columns: undefined, facet: { row: { field: 'engine' }, column: { field: 'repository' } } })).toMatchObject({ ok: true });
  });

  it.each([
    { facet: {} },
    { facet: 'engine' },
    { facet: { field: 'missing' } },
    { facet: { field: 'aic' } },
    { facet: { field: 'engine', aggregate: 'count' } },
    { facet: { field: 'engine', bin: true } },
    { facet: { field: 'engine', type: 'quantitative' } },
    { facet: { field: 'engine', row: { field: 'repository' } } },
    { facet: { field: 'engine', sort: 'ascending' } },
    { facet: { field: 'engine', 'time-unit': 'day' } },
    { columns: 0 },
    { columns: 65 },
    { columns: 1.5 },
    { facet: undefined },
    { facet: { row: { field: 'engine' } } },
    { encoding: { ...baseView.encoding, row: { field: 'engine' } } }
  ])('rejects malformed, unsupported, or ambiguous syntax: %j', (overrides) => {
    expect(validate(overrides).ok).toBe(false);
  });

  it('rejects facets on non-chart marks and columns without a facet', () => {
    expect(validate({ mark: 'metric', chart: undefined, encoding: { value: { field: 'aic' } } }).ok).toBe(false);
    expect(validate({ facet: undefined, columns: undefined, mark: 'metric', chart: undefined, encoding: { value: { field: 'aic' }, facet: { field: 'engine' } } }).ok).toBe(false);
  });

  it('accepts ordering by a facet dimension in either authoring syntax', () => {
    const data = { source: 'usage', 'order-by': [{ field: 'engine', direction: 'asc' }] };
    expect(validate({ data }).ok).toBe(true);
    expect(validate({ data, facet: undefined, encoding: { ...baseView.encoding, facet: { field: 'engine' } } }).ok).toBe(true);
  });

  it('rejects numeric and temporal derived query fields as chart facets', () => {
    for (const computed of [
      { as: 'category', function: 'number', args: [{ field: 'aic' }] },
      { as: 'category', function: 'date-bucket', args: [{ field: 'observed-at' }, { value: 'day' }] }
    ]) {
      const fixture = structuredClone(contract);
      Object.assign(fixture.dashboard, { queries: [{ name: 'derived', subject: 'Derived usage', from: 'usage', compute: [computed] }] });
      Object.assign(fixture.dashboard.pages[0].views[0], { data: { source: 'derived' }, facet: { field: 'category' } });
      expect(validateDashboardDocument(JSON.stringify(fixture)).ok).toBe(false);
    }
  });
});

describe('worker facet query contract', () => {
  it('partitions aggregated rows without combining equal x values across facets', () => {
    const { compiled, source } = execute();
    expect(compiled.queries.at(-1)).toMatchObject({ facet: { field: 'engine', as: 'facet-rows' } });
    expect(source.rows).toMatchObject([
      { 'facet-field': 'claude', 'facet-rows': [{ workflow: 'review', 'sum-aic': 7 }, { workflow: 'worker', 'sum-aic': 9 }] },
      { 'facet-field': 'copilot', 'facet-rows': [{ workflow: 'worker', 'sum-aic': 5 }] }
    ]);
    expect(source.metadata).toMatchObject({ completeness: 'complete', availability: 'available' });
  });

  it('applies declared ordering and limit globally before partitioning', () => {
    const view = { ...baseView, data: { source: 'usage', limit: 2, 'order-by': [{ field: 'sum-aic', direction: 'desc' }] } };
    const { source } = execute(view);
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]).toMatchObject({
      'facet-field': 'claude',
      'facet-rows': [{ 'sum-aic': 9 }, { 'sum-aic': 7 }]
    });
  });

  it('retains route/global scope and compiles even with query-context disabled', () => {
    const view = { ...baseView, data: { source: 'usage', 'route-field': 'repository' } };
    const compiled = compileDashboardViewPayloadQueries({
      route: { 'hash-query-parameter': 'repository' }, views: [view]
    }, 'facets', { routeParameters: { repository: 'one' }, queryContext: { filters: { engine: ['copilot'] } } });
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases,
      sources: { usage: { source: 'usage', rows: observations, metadata } }
    }));
    expect(result[compiled.aliases[0]].rows).toMatchObject([{ 'facet-field': 'copilot' }]);
    expect(execute({ ...baseView, data: { source: 'usage', 'query-context': false } }).compiled.aliases).toHaveLength(1);
  });

  it('preserves null categories and distinct raw identities even when display formatting matches', () => {
    const { source } = execute(baseView, [
      { engine: null, workflow: 'one', aic: 1 },
      { workflow: 'two', aic: 2 },
      { engine: 'unknown', workflow: 'three', aic: 3 }
    ]);
    expect(source.rows).toHaveLength(2);
    expect(source.rows[0]['facet-field']).toBeNull();
    const view = { ...baseView, facet: { field: 'workflow', format: 'workflow-relative-path' } };
    expect(execute(view, [
      { workflow: 'owner/one/.github/workflows/worker.md', aic: 1 },
      { workflow: 'owner/two/.github/workflows/worker.md', aic: 2 }
    ]).source.rows).toHaveLength(2);
  });

  it('returns observed matrix cells with worker-assigned axis positions, without empty combinations', () => {
    const view = { ...baseView, columns: undefined, facet: undefined,
      encoding: { ...baseView.encoding, row: { field: 'engine' }, column: { field: 'repository' } } };
    const { source } = execute(view);
    expect(source.rows).toMatchObject([
      { 'facet-row': 'claude', 'facet-column': 'two', 'facet-row-index': 0, 'facet-column-index': 0 },
      { 'facet-row': 'copilot', 'facet-column': 'one', 'facet-row-index': 1, 'facet-column-index': 1 }
    ]);
  });

  it('buckets timestamps and aggregates within each facet through the worker', () => {
    const view = { ...baseView, chart: 'line', encoding: {
      x: { field: 'observed-at', type: 'temporal', 'time-unit': 'day' },
      y: baseView.encoding.y
    } };
    const { source } = execute(view, [
      { engine: 'copilot', 'observed-at': '2026-10-01T01:00:00Z', aic: 2 },
      { engine: 'copilot', 'observed-at': '2026-10-01T05:00:00Z', aic: 3 },
      { engine: 'claude', 'observed-at': '2026-10-01T03:00:00Z', aic: 9 }
    ]);
    expect(source.rows).toMatchObject([
      { 'facet-field': 'claude', 'facet-rows': [{ 'sum-aic': 9 }] },
      { 'facet-field': 'copilot', 'facet-rows': [{ 'observed-at': '2026-10-01T00:00:00.000Z', 'sum-aic': 5 }] }
    ]);
  });

  it('breaks ranking ties by chart and facet dimensions before the global limit', () => {
    const view = { ...baseView, data: { source: 'usage', limit: 1, 'order-by': [{ field: 'sum-aic', direction: 'desc' }] } };
    expect(execute(view, [
      { engine: 'copilot', workflow: 'worker', aic: 5 },
      { engine: 'claude', workflow: 'worker', aic: 5 }
    ]).source.rows).toMatchObject([{ 'facet-field': 'claude' }]);
  });

  it('compares unique structured values canonically and honors aggregate-local filters', () => {
    const rows = [{ keep: false, link: { href: 'excluded' } },
      { keep: true, link: { href: 'included', label: 'Included' } },
      { keep: true, link: { label: 'Included', href: 'included' } }];
    expect(tidy(rows, [{ op: 'summarize', values: [{
      field: 'link', as: 'link', reducer: 'unique', filter: { predicates: [{ field: 'keep', equals: true }] }
    }] }])).toEqual([{ link: { label: 'Included', href: 'included' } }]);
  });

  it('rejects query facets with reserved output names or unsupported properties', () => {
    for (const facet of [
      { field: 'engine', as: 'facet-field' }, { field: 'engine', as: ' ' },
      { field: 'engine', as: 'rows', sort: 'ascending' }
    ]) {
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
        operation: 'execute-dashboard-queries', queries: [{ name: 'bad', from: 'usage', facet }],
        sourceNames: ['bad'], sources: { usage: { source: 'usage', rows: observations, metadata } }
      }));
      expect(result.bad).toMatchObject({ rows: [], metadata: { availability: 'unavailable' } });
    }
  });

  it('fails closed on more than 64 panels and keeps 64 valid', () => {
    const rows = Array.from({ length: 65 }, (_, index) => ({ engine: `engine-${index}`, workflow: 'worker', aic: 1 }));
    expect(execute(baseView, rows.slice(0, 64)).source.rows).toHaveLength(64);
    expect(execute(baseView, rows).source).toMatchObject({
      rows: [], metadata: { availability: 'unavailable', completeness: 'unknown' }
    });
  });

  it('preserves one unambiguous aggregate link and removes conflicting links', () => {
    const link = { relation: 'workflow', href: 'https://github.com/owner/repo/blob/main/worker.md', label: 'worker' };
    const view = { ...baseView, encoding: { ...baseView.encoding, href: { field: 'workflow-link' } } };
    const one = execute(view, [
      { engine: 'copilot', workflow: 'worker', aic: 2, 'workflow-link': link },
      { engine: 'copilot', workflow: 'worker', aic: 3, 'workflow-link': link }
    ]).source;
    expect(/** @type {Array<Record<string, unknown>>} */ (one.rows[0]['facet-rows'])[0]['workflow-link']).toEqual(link);
    const conflict = execute(view, [
      { engine: 'copilot', workflow: 'worker', aic: 2, 'workflow-link': link },
      { engine: 'copilot', workflow: 'worker', aic: 3, 'workflow-link': { ...link, href: 'https://github.com/owner/other' } }
    ]).source;
    expect(/** @type {Array<Record<string, unknown>>} */ (conflict.rows[0]['facet-rows'])[0]['workflow-link']).toBeNull();
  });
});

describe('facet presentation', () => {
  it('renders labeled figures without nested views or main-thread query callbacks', () => {
    const { source } = execute();
    const query = vi.fn(() => { throw new Error('UI must not query or prepare data'); });
    const root = /** @type {HTMLElement} */ (renderDataView('chart', {
      pageId: 'facets', title: 'Costs', view: baseView, sourceName: source.source,
      rows: source.rows, metadata, contextDetails: [], headingTag: 'h2',
      buildChartPoints, prepareChartPoints: query, prepareTableRows: query, toText: toViewText
    }));
    expect(root.querySelectorAll('figure')).toHaveLength(2);
    expect(root.querySelectorAll('section')).toHaveLength(0);
    expect(root.querySelectorAll('.chart-view')).toHaveLength(0);
    expect(root.querySelectorAll('.chart-facet-header')[0].textContent).toBe('Engine: claude');
    expect(root.querySelector('svg [aria-label*="7"]')).not.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('distinguishes empty, unavailable, and malformed worker payloads', () => {
    const { source } = execute(baseView, []);
    expect(render(baseView, source).textContent).toContain('No data is available');
    expect(render(baseView, { ...source, metadata: { ...metadata, availability: 'unavailable' } }).textContent).toContain('Data is unavailable');
    expect(render(baseView, { ...source, rows: observations }).querySelectorAll('figure')).toHaveLength(0);
  });

  it('keeps responsive composition centralized and releases panel chart resources on detach', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    const style = document.createElement('style');
    style.textContent = chartStyles;
    const root = render(baseView, execute().source);
    document.body.append(style, root);
    expect(root.querySelector('.chart-facet-grid')?.getAttribute('style')).toContain('--chart-facet-columns: 2');
    root.remove();
    await Promise.resolve();
    expect(document.querySelectorAll('.chart-facet-panel')).toHaveLength(0);
  });
});
