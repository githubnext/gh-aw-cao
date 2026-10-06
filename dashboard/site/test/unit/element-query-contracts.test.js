import { describe, expect, it, vi } from 'vitest';
import { disposeDashboard, renderDashboard } from '../../src/presenter.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { dashboardQueryOutputFields } from '../../src/data/queries/declarative.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/detail-query-contracts.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'element-contract', 'source-kind': 'fixture',
  'as-of': '2026-10-02T00:00:00Z', 'retrieved-at': '2026-10-02T00:00:00Z',
  availability: 'available', completeness: 'complete', freshness: 'fresh'
};
const identity = { organization: 'org', repository: 'repo', workflow: '.github/workflows/worker.md' };

/** @param {Record<string, Record<string, unknown>[]>} rows */
function sources(rows) {
  return Object.fromEntries(Object.entries(rows).map(([source, rows]) => [source, { source, metadata, rows }]));
}

const inputs = sources({
  workflows: [
    { ...identity, repository: 'other', campaign: 'unrelated', 'workflow-role': 'orchestrator' },
    { ...identity, campaign: 'selected', 'workflow-role': 'orchestrator' }
  ],
  runs: [
    { ...identity, repository: 'other', run: 'unrelated', 'run-conclusion': 'success' },
    ...['success', 'failure', 'startup-failure', 'stale', 'timed-out', 'action-required', 'cancelled', 'neutral', 'skipped', 'unknown']
      .map((conclusion, index) => ({ ...identity, run: String(index), 'run-conclusion': conclusion, 'run-status': 'completed' })),
    { ...identity, run: 'queued', 'run-conclusion': 'unknown', 'run-status': 'queued' },
    { ...identity, run: 'running', 'run-conclusion': 'unknown', 'run-status': 'in-progress' }
  ],
  usage: [
    { ...identity, repository: 'other', run: 'unrelated', aic: 999 },
    { ...identity, run: 'one', aic: 2.5 }, { ...identity, run: 'two', aic: 7.5 }
  ],
  domains: [
    { domain: 'unrelated.example' },
    ...Array.from({ length: 5000 }, (_, index) => ({ domain: 'api.github.com', 'request-count': index }))
  ],
  audits: [{ 'event-summary': 'Unrelated' }, { 'event-summary': 'Selected event' }, { 'event-summary': 'Selected event' }],
  'mcp-calls': [{ 'mcp-server': 'unrelated', 'mcp-tool': 'issue_read' }, { 'mcp-server': 'github', 'mcp-tool': 'issue_read' }],
  outcomes: [{ 'safe-output': 'unrelated' }, { 'safe-output': 'selected-output' }],
  campaigns: [{ campaign: 'unrelated', 'campaign-readme': '# Wrong' }, { campaign: 'selected', 'campaign-readme': '# Selected' }],
  'marketplace-packages': [{ 'package-source': 'unrelated' }, { 'package-source': 'selected-package', 'package-readme': '# Selected' }]
});

/** @param {typeof contract.elementViews[number]} entry @param {Record<string, string | undefined>} routeParameters */
function compile(entry, routeParameters) {
  return compileDashboardViewPayloadQueries(
    dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === entry.page),
    entry.page,
    { viewId: entry.id, routeParameters: Object.fromEntries(Object.entries(routeParameters)
      .flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])),
      queries: dashboard.queries, views: dashboard.views }
  );
}

/** @param {ReturnType<typeof compile>} payload @param {typeof inputs} [input] */
function execute(payload, input = inputs) {
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: payload.queries, sourceNames: payload.aliases, sources: input
  }));
}

describe('bounded element query contracts', () => {
  it.each(contract.elementViews)('$page/$id selects before bounding every declared source', (entry) => {
    const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === entry.page);
    const view = page.views.find((/** @type {{ id: string }} */ view) => view.id === entry.id);
    expect(view.data.sources).toEqual(entry.sources);
    expect(view.data.limit).toBe(1);
    const payload = compile(entry, entry.route);
    const result = execute(payload);
    expect(Object.keys(result)).toEqual(payload.aliases);
    for (const source of Object.values(result)) {
      expect(source.metadata.availability).toBe('available');
      expect(source.rows).toHaveLength(1);
      expect(JSON.stringify(source.rows)).not.toContain('unrelated');
    }
    for (const route of [{}, Object.fromEntries(Object.keys(entry.route).map((key) => [key, 'missing']))]) {
      const empty = execute(compile(entry, route));
      expect(Object.values(empty).every((source) => source.rows.length === 0)).toBe(true);
    }
  });

  it('returns aggregate health and AIC instead of transporting selected runs', () => {
    const entry = contract.elementViews.find((entry) => entry.id === 'workflow-runtime-route');
    if (!entry) throw new Error('Missing workflow runtime contract');
    const payload = compile(entry, entry.route);
    const result = execute(payload);
    expect(result[payload.aliases[1]].rows).toEqual([{
      ...identity, total: 12, successful: 1, failed: 4, approval: 1, pending: 2, other: 4
    }]);
    expect(result[payload.aliases[2]].rows).toEqual([{ ...identity, aic: 10, 'telemetry-count': 2 }]);
    const unavailable = execute(payload, {
      ...inputs,
      runs: { source: 'runs', rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(unavailable[payload.aliases[1]].metadata.availability).toBe('unavailable');
  });

  it('retains the active route when the subscribed element root is replaced', async () => {
    const entry = contract.elementViews.find((entry) => entry.id === 'workflow-runtime-route');
    if (!entry) throw new Error('Missing workflow runtime contract');
    const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === entry.page);
    const payload = compile(entry, entry.route);
    const requests = new Map();
    const loader = /** @type {import('../../src/presenter.js').PageSourceLoader} */ (vi.fn(() => {
      throw new Error('A bounded route must not request page-wide sources.');
    }));
    loader.subscribeViewSources = (_pageId, viewId, names, options) => new Promise((resolve) => {
      requests.set(viewId, { names, options, resolve });
    });
    const previousUrl = window.location.href;
    const routeParameters = Object.fromEntries(Object.entries(entry.route).flatMap(([name, value]) => (
      typeof value === 'string' ? [[name, value]] : []
    )));
    window.history.replaceState({}, '', `#page-${entry.page}?${new URLSearchParams(routeParameters)}`);
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'subscribed-element-contract', title: 'Subscribed element contract', queries: dashboard.queries,
          pages: [{ ...page, views: page.views.filter((/** @type {{ id: string }} */ view) => view.id === entry.id) }]
        }
      },
      sources: {},
      loadPageSources: loader
    });
    document.body.append(rendered);
    try {
      await vi.waitFor(() => expect(requests.has(entry.id)).toBe(true));
      const request = requests.get(entry.id);
      expect(request.names).toEqual(entry.sources);
      request.resolve(execute(payload));
      await vi.waitFor(() => expect(rendered.querySelector('.workflow-health-total')?.textContent).toBe('12runs'));
      const initialRoot = rendered.querySelector('[data-route-view]');
      request.options.onUpdate(execute(payload, {
        ...inputs,
        runs: { ...inputs.runs, rows: [...inputs.runs.rows, { ...identity, run: 'new', 'run-conclusion': 'success' }] }
      }));
      await vi.waitFor(() => expect(rendered.querySelector('.workflow-health-total')?.textContent).toBe('13runs'));
      expect(rendered.querySelector('[data-route-view]')).not.toBe(initialRoot);
      expect(rendered.textContent).not.toContain('Select a workflow');
    } finally {
      disposeDashboard(rendered);
      rendered.remove();
      window.history.replaceState({}, '', previousUrl);
    }
  });

  it('projects ordered metric panels and preserves duplicate observations and individual run links', () => {
    const definition = dashboard.queries.find((/** @type {{ name: string }} */ query) => query.name === 'campaign-operational-value-primary-series');
    expect(dashboardQueryOutputFields(definition, () => TABLE_FIELDS['operational-values'])).toEqual(contract.temporalPanelFields);
    const base = {
      campaign: 'selected', organization: 'org', repository: 'z',
      'operational-value-definition': 'metric', 'operational-value': 10,
      'operational-value-name': 'Metric', 'operational-value-unit': 'count', 'operational-value-direction': 'increase'
    };
    const links = [1, 2, 3].map((run) => ({ relation: 'run', href: `https://github.com/org/repo/actions/runs/${run}` }));
    const payload = compileDashboardViewPayloadQueries(
      dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'campaign-insights'), 'campaign-insights',
      { queries: dashboard.queries, viewId: 'campaign-operational-value-history',
        sourceNames: ['campaign-operational-value-primary-series'], routeParameters: { campaign: 'selected' } }
    );
    const result = execute(payload, sources({
      'operational-values': [
        { ...base, campaign: 'unrelated', 'observed-at': '2026-10-01T00:00:00Z' },
        { ...base, 'observed-at': '2026-10-02T00:00:00Z', 'run-link': links[0] },
        { ...base, 'observed-at': '2026-10-01T00:00:00Z', 'run-link': links[1] },
        { ...base, 'observed-at': '2026-10-01T00:00:00Z', 'run-link': links[2] },
        { ...base, repository: 'a', 'observed-at': '2026-10-01T00:00:00Z' },
        { ...base, 'observed-at': 'invalid' },
        { ...base, 'observed-at': '2026-10-01T00:00:00Z', 'operational-value': null }
      ]
    }))[payload.aliases[0]];
    expect(result.metadata.availability).toBe('available');
    expect(result.rows).toHaveLength(1);
    const series = /** @type {{ id: string, points: { x: string, link?: unknown }[] }[]} */ (result.rows[0].series);
    expect(series.map((entry) => entry.id)).toEqual(['org/a', 'org/z']);
    expect(series[1].points.map((point) => point.link)).toEqual([links[1], links[2], links[0]]);
    expect(series[0].points[0]).not.toHaveProperty('link');
  });
});
