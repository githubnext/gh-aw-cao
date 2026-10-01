import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { compileDashboardQueryTypes } from '../../src/query-type-checker.js';
import { processDataRequest } from '../../src/data-worker.js';
import { loadDatabaseQuerySources, queryDatabaseSources } from '../../src/data/queries/database.js';
import { executeDashboardQueries, resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { validateDashboardDocument } from '../../src/validator.js';

const query = {
  name: 'simulated-series',
  subject: 'A synthetic day series for an interactive simulation.',
  from: 'simulation-days',
  compute: [{ as: 'score', function: 'product', args: [{ field: 'day' }, { value: 2 }] }],
  select: [{ field: 'day' }, { field: 'date' }, { field: 'score' }],
  'order-by': [{ field: 'day' }]
};

describe('simulation-days intrinsic query source', () => {
  it('resolves as a typed leaf and rejects invalid fields and shadowing', () => {
    expect(resolveDashboardQuerySources([query], ['simulated-series'])).toEqual([
      'simulated-series', 'simulation-days'
    ]);
    expect(compileDashboardQueryTypes([query])).toMatchObject({
      errors: [],
      queryFields: new Map([['simulated-series', ['day', 'date', 'score']]])
    });
    expect(compileDashboardQueryTypes([{
      name: 'bad-days', from: 'simulation-days',
      compute: [{ as: 'bad', function: 'number', args: [{ field: 'missing' }] }]
    }]).errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E010', path: '$.dashboard.queries[0].compute[0].args[0].field'
    }));
    expect(compileDashboardQueryTypes([{ name: 'simulation-days', from: 'simulation-days' }]).errors)
      .toContainEqual(expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].name' }));
  });

  it('projects thirty ordered numeric rows without opening canonical IndexedDB', async () => {
    const indexedDB = { open: () => { throw new Error('unexpected IndexedDB access'); } };
    const source = (await queryDatabaseSources(
      /** @type {IDBFactory} */ (/** @type {unknown} */ (indexedDB)),
      { 'simulation-days': { rows: [{ day: 999 }], metadata: { availability: 'available' } } },
      ['simulation-days']
    ))['simulation-days'];
    expect(source.rows).toEqual(Array.from({ length: 30 }, (_, index) => ({
      day: index + 1, date: new Date(Date.UTC(2025, 0, index + 1)).toISOString()
    })));
    expect(source.metadata).toMatchObject({ 'source-kind': 'synthetic', availability: 'available' });
    const projected = executeDashboardQueries([query], { 'simulation-days': source }, ['simulated-series']);
    expect(projected['simulated-series'].rows).toEqual(
      Array.from({ length: 30 }, (_, index) => ({
        day: index + 1,
        date: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
        score: (index + 1) * 2
      }))
    );
    const loaded = await loadDatabaseQuerySources(
      /** @type {IDBFactory} */ (/** @type {unknown} */ (indexedDB)),
      {}, { queries: [query], sourceNames: ['simulated-series'] }
    );
    expect(/** @type {import('../../src/presenter.js').LogicalSourceInput} */ (loaded['simulated-series']).rows)
      .toEqual(projected['simulated-series'].rows);
  });

  it('resolves a worker query graph with no canonical database access', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    try {
      const response = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
        await processDataRequest({
          operation: 'load-dashboard-query-sources',
          sources: {},
          queries: [query],
          sourceNames: ['simulated-series']
        })
      );
      expect(response['simulated-series'].rows).toHaveLength(30);
      expect(response['simulated-series'].rows[0])
        .toEqual({ day: 1, date: '2025-01-01T00:00:00.000Z', score: 2 });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('resolves the intrinsic when executing a declared graph without supplied sources', () => {
    const response = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      processDataRequest({
        operation: 'execute-dashboard-queries',
        sources: {},
        queries: [query],
        sourceNames: ['simulated-series']
      })
    );
    expect(response['simulated-series'].metadata.availability).toBe('available');
    expect(response['simulated-series'].rows).toHaveLength(30);
    expect(response['simulated-series'].rows[29])
      .toEqual({ day: 30, date: '2025-01-30T00:00:00.000Z', score: 60 });
  });

  it('accepts a view querying the intrinsic source through the document validator', () => {
    const document = {
      'language-version': '0.1.0',
      dashboard: {
        id: 'synthetic-test', title: 'Synthetic test',
        defaults: { scope: {}, time: {}, filters: {} },
        queries: [query],
        pages: [{
          id: 'simulator', kind: 'custom', title: 'Simulator',
          views: [{
            id: 'daily-projection',
            data: { source: 'simulated-series' },
            mark: 'chart',
            encoding: {
              x: { field: 'date', type: 'temporal', 'time-unit': 'day' },
              y: { field: 'score', aggregate: 'max', type: 'quantitative' }
            }
          }]
        }]
      }
    };
    const result = validateDashboardDocument(JSON.stringify(document));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
