import { describe, expect, it } from 'vitest';
import {
  buildDashboardQueryUsageGraph,
  findDeadDashboardQueries
} from '../../src/query-usage.js';

describe('dashboard query usage graph', () => {
  it('retains transitive dependencies from inline and reusable views and callouts', () => {
    const dashboard = {
      queries: [
        { name: 'base', from: 'runs' },
        { name: 'joined', from: 'base', joins: [{ source: 'workflows' }] },
        { name: 'reusable', from: 'joined' },
        { name: 'callout', from: 'findings' },
        { name: 'dead', from: 'runs' }
      ],
      views: [{ id: 'shared', data: { source: 'reusable' } }],
      pages: [
        { kind: 'custom', views: [{ data: { source: 'joined' } }, 'shared'] }
      ],
      callouts: [{ 'visible-when': { source: 'callout' } }]
    };

    const { graph } = buildDashboardQueryUsageGraph(dashboard);
    expect([...(graph.get('query:joined') ?? [])]).toEqual(['query:base']);
    expect(findDeadDashboardQueries(dashboard)).toEqual([
      { name: 'dead', path: '$.dashboard.queries[4].name' }
    ]);
  });

  it('rejects queries used only by unreferenced reusable views', () => {
    const dashboard = {
      queries: [{ name: 'orphan', from: 'runs' }],
      views: [{ id: 'unused', data: { source: 'orphan' } }],
      pages: [{ kind: 'custom', views: [] }]
    };

    expect(findDeadDashboardQueries(dashboard)).toEqual([
      { name: 'orphan', path: '$.dashboard.queries[0].name' }
    ]);
  });

  it('retains queries used by section count sources', () => {
    const dashboard = {
      queries: [
        { name: 'single-count', from: 'runs' },
        { name: 'group-count', from: 'workflows' }
      ],
      pages: [{
        kind: 'custom',
        views: [],
        sections: [
          { 'count-source': 'single-count' },
          { 'count-sources': ['group-count'] }
        ]
      }]
    };

    expect(findDeadDashboardQueries(dashboard)).toEqual([]);
  });
});
