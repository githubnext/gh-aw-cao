import { expect, it } from 'vitest';
import { tidy } from '../../src/data-operations.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
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