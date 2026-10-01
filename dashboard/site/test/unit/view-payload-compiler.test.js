import { expect, it } from 'vitest';
import { tidy } from '../../src/data-operations.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { renderCustomViewStateDetails } from '../../src/components/view-chrome.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import {
  compileDashboardViewPayloadQueries,
  dashboardViewAliasName
} from '../../src/data/queries/view-payload-compiler.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T12:00:00Z',
  'retrieved-at': '2026-09-11T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

it('traces an unavailable MCP view alias through its scoped query graph to the missing source', () => {
  const dashboard = authoritativeDashboard.dashboard;
  const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'mcps');
  const payload = compileDashboardViewPayloadQueries(page, 'mcps', {
    queries: dashboard.queries,
    views: dashboard.views,
    viewId: 'mcp-top-tools',
    sourceNames: ['mcp-top-tools']
  });

  const alias = payload.aliases[0];
  const unavailable = executeDashboardQueries(payload.queries, {
    'mcp-calls': { source: 'mcp-calls', rows: [], metadata: { ...metadata, availability: 'unavailable' } }
  }, payload.aliases)[alias];
  expect(unavailable.metadata.availability).toBe('unavailable');
  expect(unavailable.metadata['query-error']).toEqual({ code: 'input-unavailable', source: 'mcp-calls' });
  expect(renderCustomViewStateDetails(
    'mcp-top-tools', [], unavailable.metadata['query-error'], unavailable.metadata['query-diagnostic']
  ).map((detail) => detail.textContent)).toContain('Unavailable query dependency: mcp-calls');

  const empty = executeDashboardQueries(payload.queries, {
    'mcp-calls': { source: 'mcp-calls', rows: [], metadata: { ...metadata, availability: 'empty' } }
  }, payload.aliases)[alias];
  expect(empty.metadata.availability).toBe('empty');
  expect(empty.metadata['query-error']).toBeUndefined();
});

it('keeps a relative-time query scoped even when the view opts out of global context', () => {
  const page = { views: [{ id: 'recent', mark: 'chart', data: { source: 'recent', 'query-context': false } }] };
  const payload = compileDashboardViewPayloadQueries(page, 'recent', {
    queries: [
      { name: 'base', from: 'runs', time: { range: '7d' } },
      { name: 'recent', from: 'base' }
    ],
    sourceNames: ['recent'],
    evaluatedAt: '2026-09-24T00:00:00Z'
  });

  expect(payload.aliases).toHaveLength(1);
  expect(payload.queries.some((query) => {
    const filter = /** @type {{ predicates?: Array<{ field: string }> } | undefined} */ (query.filter);
    return filter?.predicates?.some((predicate) => predicate.field === '@time');
  })).toBe(true);
});

it('compiles view aliases for element views when query-context is false', () => {
  const page = {
    views: [{
      id: 'controls',
      mark: 'element',
      element: 'custom-controls',
      data: { sources: ['options'], 'query-context': false }
    }]
  };
  const payload = compileDashboardViewPayloadQueries(page, 'custom', {
    queries: [{ name: 'options', from: 'packages' }],
    sourceNames: ['options']
  });

  expect(payload.aliases).toEqual(['view:custom:controls:options']);
  expect(payload.queries).toHaveLength(1);
  expect(payload.queries[0].name).toBe('view:custom:controls:options');
});

it('compiles distinct aliases when two views filter the same source differently', () => {
  const page = {
    views: [
      { id: 'successes', data: { source: 'runs', filters: { 'run-conclusion': 'success' } } },
      { id: 'failures', data: { source: 'runs', filters: { 'run-conclusion': 'failure' } } }
    ]
  };
  const payload = compileDashboardViewPayloadQueries(page, 'operations');
  const sources = {
    runs: {
      source: 'runs',
      rows: [{ run: '1', 'run-conclusion': 'success' }, { run: '2', 'run-conclusion': 'failure' }],
      metadata
    }
  };
  const results = executeDashboardQueries(payload.queries, sources, payload.aliases);

  expect(results[dashboardViewAliasName('operations', page.views[0], 0, 'runs')].rows).toEqual([sources.runs.rows[0]]);
  expect(results[dashboardViewAliasName('operations', page.views[1], 1, 'runs')].rows).toEqual([sources.runs.rows[1]]);
});

it('compiles the generated identifier for an unnamed bound view regardless of page mode', () => {
  const page = {
    views: [{ mark: 'table', data: { source: 'runs', filters: { 'run-conclusion': 'success' } } }]
  };
  const payload = compileDashboardViewPayloadQueries(page, 'operations', {
    viewId: 'view-1',
    queryContext: { viewMode: 'chart' }
  });
  expect(payload.aliases).toEqual([dashboardViewAliasName('operations', page.views[0], 0, 'runs')]);
  expect(payload.queries[0]).toMatchObject({
    filter: { predicates: [{ field: 'run-conclusion', equals: 'success' }] }
  });
});

it('resolves page form defaults and runtime values into typed query parameters', () => {
  const page = {
    form: {
      fields: [
        { id: 'minimum-aic', default: 10 },
        { id: 'multiplier', default: 2 },
        { id: 'include-live', default: true }
      ]
    },
    views: [{ id: 'simulation', data: { source: 'simulated-usage' } }]
  };
  const definitions = [{
    name: 'simulated-usage',
    parameters: [
      { name: 'minimum-aic', type: 'number' },
      { name: 'multiplier', type: 'number' },
      { name: 'include-live', type: 'boolean' }
    ],
    from: 'usage',
    filter: {
      predicates: [
        { field: 'aic', gte: { parameter: 'minimum-aic' } },
        { field: 'is-live', equals: { parameter: 'include-live' } }
      ]
    },
    compute: [{
      as: 'simulated-aic',
      function: 'product',
      args: [{ field: 'aic' }, { parameter: 'multiplier' }]
    }]
  }];
  const payload = compileDashboardViewPayloadQueries(page, 'simulator', {
    queries: definitions,
    queryContext: { formValues: { multiplier: 3 } }
  });

  expect(payload.queries[0]).toMatchObject({
    filter: {
      predicates: [
        { field: 'aic', gte: 10 },
        { field: 'is-live', equals: true }
      ]
    },
    compute: [{
      args: [{ field: 'aic' }, { value: 3 }]
    }]
  });
});

it('fails closed when a required form parameter has no default or runtime value', () => {
  expect(() => compileDashboardViewPayloadQueries({
    views: [{ id: 'simulation', data: { source: 'simulated-usage' } }]
  }, 'simulator', {
    queries: [{
      name: 'simulated-usage',
      parameters: [{ name: 'multiplier', type: 'number' }],
      from: 'usage',
      compute: [{
        as: 'simulated-aic',
        function: 'product',
        args: [{ field: 'aic' }, { parameter: 'multiplier' }]
      }]
    }]
  })).toThrow('requires form parameter "multiplier"');
});

it('resolves parameters only in the selected view query dependency graph', () => {
  const definitions = [
    { name: 'chosen', from: 'runs' },
    {
      name: 'unrelated',
      from: 'simulation-days',
      parameters: [{ name: 'multiplier', type: 'number' }],
      compute: [{
        as: 'score',
        function: 'product',
        args: [{ field: 'day' }, { parameter: 'multiplier' }]
      }]
    }
  ];
  const page = {
    views: [
      { id: 'selected', data: { source: 'chosen' } },
      { id: 'other', data: { source: 'unrelated' } }
    ]
  };
  expect(() => compileDashboardViewPayloadQueries(page, 'tests', {
    queries: definitions,
    viewId: 'selected'
  })).not.toThrow();
  expect(() => compileDashboardViewPayloadQueries(page, 'tests', {
    queries: definitions,
    viewId: 'other'
  })).toThrow('requires form parameter "multiplier"');
});

it('compiles only the independently requested view payload', () => {
  const page = {
    views: [
      { id: 'header', data: { sources: ['runs', 'outcomes'] } },
      { id: 'floor', data: { sources: ['runs', 'dispatches'] } }
    ]
  };

  const payload = compileDashboardViewPayloadQueries(page, 'overview', { viewId: 'floor' });

  expect(payload.aliases).toEqual([
    dashboardViewAliasName('overview', page.views[1], 1, 'runs', 0),
    dashboardViewAliasName('overview', page.views[1], 1, 'dispatches', 1)
  ]);
  expect(payload.aliases.every((alias) => alias.includes(':floor:'))).toBe(true);
});

it('omits view aliases whose sources are not requested by a page subscription', () => {
  const page = {
    views: [
      { id: 'independent-header', data: { sources: ['outcomes', 'runs'] } },
      { id: 'page-health', data: { source: 'health' } }
    ]
  };

  const payload = compileDashboardViewPayloadQueries(page, 'overview', {
    sourceNames: new Set(['health'])
  });

  expect(payload.aliases).toEqual([
    dashboardViewAliasName('overview', page.views[1], 1, 'health')
  ]);
  expect(payload.queries).toHaveLength(1);
  expect(payload.queries[0].from).toBe('health');
});

it('keeps unmodified canonical row listings on the native source path', () => {
  const page = {
    views: [{ id: 'repositories', mark: 'list', data: { source: 'repositories' } }]
  };

  const native = compileDashboardViewPayloadQueries(page, 'repositories', {
    queries: [{ name: 'derived', from: 'repositories' }],
    queryContext: { viewMode: 'card' }
  });
  const filtered = compileDashboardViewPayloadQueries(page, 'repositories', {
    queries: [{ name: 'derived', from: 'repositories' }],
    queryContext: {
      viewMode: 'card',
      search: { fields: ['repository'], query: 'cao' }
    }
  });

  expect(native).toEqual({ aliases: [], queries: [], replacedSources: [] });
  expect(filtered.aliases).toEqual([
    dashboardViewAliasName('repositories', page.views[0], 0, 'repositories')
  ]);
  expect(filtered.queries).toHaveLength(1);
});

it('compiles only views selected by the page view mode', () => {
  const page = {
    views: [
      { id: 'navigation', mark: 'element', data: { source: 'navigation' } },
      { id: 'trend', mark: 'chart', data: { source: 'run-trend' } },
      { id: 'runs', mark: 'table', data: { source: 'runs' } },
      { id: 'notices', mark: 'list', data: { source: 'notices' } },
      { id: 'details', mark: 'table', disclosure: 'supplemental', data: { source: 'run-details' } }
    ]
  };

  const chart = compileDashboardViewPayloadQueries(page, 'runs', { queryContext: { viewMode: 'chart' } });
  const table = compileDashboardViewPayloadQueries(page, 'runs', { queryContext: { viewMode: 'table' } });
  const card = compileDashboardViewPayloadQueries(page, 'runs', { queryContext: { viewMode: 'card' } });

  expect(chart.aliases).toEqual([
    dashboardViewAliasName('runs', page.views[0], 0, 'navigation'),
    dashboardViewAliasName('runs', page.views[1], 1, 'run-trend'),
    dashboardViewAliasName('runs', page.views[4], 4, 'run-details')
  ]);
  expect(table.aliases).toEqual([
    dashboardViewAliasName('runs', page.views[0], 0, 'navigation'),
    dashboardViewAliasName('runs', page.views[2], 2, 'runs'),
    dashboardViewAliasName('runs', page.views[4], 4, 'run-details')
  ]);
  expect(card.aliases).toEqual([
    dashboardViewAliasName('runs', page.views[0], 0, 'navigation'),
    dashboardViewAliasName('runs', page.views[2], 2, 'runs'),
    dashboardViewAliasName('runs', page.views[4], 4, 'run-details')
  ]);
});

it('binds every named drill argument to a worker query predicate and fails closed when missing', () => {
  const page = {
    views: [{
      id: 'issue-events',
      data: {
        source: 'events',
        arguments: [
          { name: 'repository', field: 'repository' },
          { name: 'issue-id', field: 'correlation-id' }
        ]
      }
    }]
  };
  const bound = compileDashboardViewPayloadQueries(page, 'issue-events', {
    routeParameters: { repository: 'gh-aw-cao', 'issue-id': '42' }
  });
  const missing = compileDashboardViewPayloadQueries(page, 'issue-events', {
    routeParameters: { repository: 'gh-aw-cao' }
  });

  expect(/** @type {any} */ (bound.queries[0]).filter.predicates).toEqual([
    { field: 'repository', equals: 'gh-aw-cao' },
    { field: 'correlation-id', equals: '42' }
  ]);
  expect(/** @type {any} */ (missing.queries[0]).filter.predicates).toEqual([
    { field: 'repository', equals: 'gh-aw-cao' },
    { field: 'correlation-id', equals: '' }
  ]);
});

it('injects route and runtime predicates before a declared aggregate executes', () => {
  const page = {
    route: { 'hash-query-parameter': 'repository' },
    views: [{
      id: 'run-total',
      data: { source: 'successful-run-total', 'route-field': 'repository' }
    }]
  };
  const definitions = [{
    name: 'successful-run-total',
    from: 'runs',
    filter: { predicates: [{ field: 'run-conclusion', equals: 'success' }] },
    aggregate: { values: [{ field: 'run', as: 'count', reducer: 'count' }] }
  }];
  const payload = compileDashboardViewPayloadQueries(page, 'repository', {
    queries: definitions,
    routeParameters: { repository: 'alpha' },
    queryContext: {
      filters: { mode: ['live'] },
      timeWindow: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }
    }
  });

  const results = executeDashboardQueries(payload.queries, {
    runs: {
      source: 'runs',
      rows: [
        { run: '1', repository: 'alpha', 'run-conclusion': 'success', 'rollout-mode': 'live', 'started-at': '2026-09-10T00:00:00Z' },
        { run: '2', repository: 'alpha', 'run-conclusion': 'success', 'rollout-mode': 'review', 'started-at': '2026-09-10T00:00:00Z' },
        { run: '3', repository: 'alpha', 'run-conclusion': 'success', 'rollout-mode': 'live', 'started-at': '2026-08-10T00:00:00Z' },
        { run: '4', repository: 'beta', 'run-conclusion': 'success', 'rollout-mode': 'live', 'started-at': '2026-09-10T00:00:00Z' }
      ],
      metadata
    }
  }, payload.aliases);

  expect(results[payload.aliases[0]].rows).toEqual([{ count: 1 }]);
});

it('fails closed when a route-scoped view has no route value', () => {
  const page = {
    route: { 'hash-query-parameter': 'campaign' },
    views: [{
      id: 'campaign-issues',
      data: { source: 'outcomes', 'route-field': 'campaign' }
    }]
  };
  const payload = compileDashboardViewPayloadQueries(page, 'campaign-issues');
  const results = executeDashboardQueries(payload.queries, {
    outcomes: {
      source: 'outcomes',
      rows: [
        { campaign: 'alpha', 'safe-output': 'issue-1' },
        { campaign: 'beta', 'safe-output': 'issue-2' },
        { campaign: '', 'safe-output': 'unattributed' }
      ],
      metadata
    }
  }, payload.aliases);

  expect(/** @type {any} */ (payload.queries[0]).filter.predicates).toEqual([
    { field: 'campaign', equals: '' },
    { field: 'campaign', equals: '\0' }
  ]);
  expect(results[payload.aliases[0]].rows).toEqual([]);
});

it('applies route scope after a declared query creates the route field', () => {
  const page = {
    route: { 'hash-query-parameter': 'campaign' },
    views: [{
      id: 'campaign-runs',
      data: { source: 'campaign-runs', 'route-field': 'campaign' }
    }]
  };
  const payload = compileDashboardViewPayloadQueries(page, 'campaign-runs', {
    routeParameters: { campaign: 'beta' },
    queryContext: { filters: { mode: ['live'] } },
    queries: [{
      name: 'campaign-runs',
      from: 'runs',
      compute: [{ as: 'declared-campaign', function: 'coalesce', args: [{ field: 'source-campaign' }] }],
      select: [
        { field: 'run' },
        { field: 'declared-campaign', as: 'campaign' }
      ],
      limit: 1
    }]
  });
  const results = executeDashboardQueries(payload.queries, {
    runs: {
      source: 'runs',
      rows: [
        { run: '1', 'source-campaign': 'alpha', 'rollout-mode': 'live' },
        { run: '2', 'source-campaign': 'alpha', 'rollout-mode': 'review' },
        { run: '3', 'source-campaign': 'beta', 'rollout-mode': 'live' }
      ],
      metadata
    }
  }, payload.aliases);

  expect(results[payload.aliases[0]].rows).toEqual([{ run: '3', campaign: 'beta' }]);
});

it('applies the selected horizon before derived repository totals aggregate runs', () => {
  const page = {
    views: [{ id: 'repositories', data: { source: 'repository-activity' } }]
  };
  const definitions = [
    {
      name: 'repository-run-totals',
      from: 'runs',
      aggregate: {
        by: ['repository'],
        values: [{ field: 'run', as: 'runs', reducer: 'distinct-count' }]
      }
    },
    {
      name: 'repository-activity',
      from: 'repositories',
      joins: [{
        source: 'repository-run-totals',
        type: 'left',
        on: [{ left: 'repository', right: 'repository' }],
        fields: [{ field: 'runs', as: 'runs' }]
      }]
    }
  ];
  const payload = compileDashboardViewPayloadQueries(page, 'repositories', {
    queries: definitions,
    queryContext: {
      timeWindow: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }
    }
  });
  const results = executeDashboardQueries(payload.queries, {
    repositories: {
      source: 'repositories',
      rows: [{ repository: 'alpha' }, { repository: 'beta' }],
      metadata
    },
    runs: {
      source: 'runs',
      rows: [
        { run: '1', repository: 'alpha', 'started-at': '2026-09-10T00:00:00Z' },
        { run: '2', repository: 'alpha', 'started-at': '2026-08-10T00:00:00Z' },
        { run: '3', repository: 'beta', 'started-at': '2026-08-10T00:00:00Z' }
      ],
      metadata
    }
  }, payload.aliases);

  expect(results[payload.aliases[0]].rows).toEqual([
    { repository: 'alpha', runs: 1 },
    { repository: 'beta', runs: null }
  ]);
});

it('uses a declared history window and resolves time-end for calendar rhythm queries', () => {
  const page = {
    views: [{ id: 'rhythm', data: { source: 'overview-rhythm', time: {
      start: '2026-09-02T12:00:00Z',
      end: '2026-09-09T12:00:00Z'
    } } }]
  };
  const definitions = [{
    name: 'overview-rhythm',
    from: 'runs',
    time: { range: '15d' },
    compute: [{
      as: 'point',
      function: 'calendar-week-point',
      args: [
        { field: 'started-at' },
        { context: 'time-end' },
        { field: 'run-conclusion' }
      ]
    }],
    aggregate: { values: [{ field: 'point', as: 'rhythm', reducer: 'calendar-week-rhythm' }] }
  }];
  const payload = compileDashboardViewPayloadQueries(page, 'overview', { queries: definitions });
  const compiled = /** @type {any} */ (payload.queries[0]);

  expect(compiled.filter.predicates).toContainEqual({ field: '@time', gte: '2026-08-25T12:00:00.000Z' });
  expect(compiled.compute[0].args[1]).toEqual({ value: '2026-09-09T12:00:00Z' });

  const results = executeDashboardQueries(payload.queries, {
    runs: {
      source: 'runs',
      rows: [
        { 'started-at': '2026-09-09T08:00:00Z', 'run-conclusion': 'success' },
        { 'started-at': '2026-09-03T08:00:00Z', 'run-conclusion': 'success' },
        { 'started-at': '2026-08-28T08:00:00Z', 'run-conclusion': 'success' }
      ],
      metadata
    }
  }, payload.aliases);
  const rhythm = /** @type {any} */ (results[payload.aliases[0]].rows[0]?.rhythm);

  expect(rhythm.days).toHaveLength(7);
  expect(rhythm.days[0]).toMatchObject({ label: 'Mon', reached: true });
  expect(rhythm.days[2]).toMatchObject({ label: 'Wed', current: 1, reached: true });
  expect(rhythm.days[3]).toMatchObject({ label: 'Thu', previous: 1, reached: false });
  expect(rhythm.days[6]).toMatchObject({ label: 'Sun', reached: false });
});

it('resolves query time from the evaluated instant before a view horizon exists', () => {
  const payload = compileDashboardViewPayloadQueries({
    views: [{ id: 'rhythm', data: { source: 'overview-rhythm' } }]
  }, 'overview', {
    evaluatedAt: '2026-09-09T12:00:00Z',
    queries: [{
      name: 'overview-rhythm',
      from: 'runs',
      time: { range: '15d' },
      compute: [{
        as: 'point',
        function: 'calendar-week-point',
        args: [{ field: 'started-at' }, { context: 'time-end' }, { field: 'run-conclusion' }]
      }]
    }]
  });
  const compiled = /** @type {any} */ (payload.queries[0]);

  expect(compiled.filter.predicates).toEqual([
    { field: '@time', gte: '2026-08-25T12:00:00.000Z' },
    { field: '@time', lt: '2026-09-09T12:00:00Z' }
  ]);
  expect(compiled.compute[0].args[1]).toEqual({ value: '2026-09-09T12:00:00Z' });
});

it('compiles request search into the worker query alias', () => {
  const payload = compileDashboardViewPayloadQueries({
    views: [{ id: 'work', data: { source: 'work-project-items' } }]
  }, 'work', {
    queryContext: {
      search: { fields: ['work-search'], query: ' release train ' },
      orderBy: [{ field: 'work-name', direction: 'asc' }]
    }
  });

  expect(payload.queries[0]).toMatchObject({
    name: 'view:work:work:work-project-items',
    from: 'work-project-items',
    filter: { search: { fields: ['work-search'], query: 'release train' } },
    'order-by': [{ field: 'work-name', direction: 'asc' }]
  });
});

it('supports optional filters, temporal bounds, and UTC-day computation in row operators', () => {
  const rows = tidy([
    { id: 'missing-mode', 'started-at': '2026-09-10T23:30:00-02:00' },
    { id: 'review', mode: 'review', 'started-at': '2026-09-09T00:00:00Z' },
    { id: 'old', 'started-at': '2026-08-01T00:00:00Z' }
  ], [
    { op: 'filter', predicates: [
      { field: 'mode', in: ['live'], optional: true },
      { field: '@time', gte: '2026-09-01T00:00:00Z', lt: '2026-10-01T00:00:00Z' }
    ] },
    { op: 'compute', values: [{ as: 'day', function: 'date-day', args: [{ field: 'started-at' }] }] }
  ]);

  expect(rows).toEqual([{ id: 'missing-mode', 'started-at': '2026-09-10T23:30:00-02:00', day: '2026-09-11' }]);
});