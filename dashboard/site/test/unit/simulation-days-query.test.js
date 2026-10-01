import { describe, expect, it } from 'vitest';
import { compileDashboardQueryTypes } from '../../src/query-type-checker.js';
import { loadDatabaseQuerySources, queryDatabaseSources } from '../../src/data/queries/database.js';
import { executeDashboardQueries, resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { validateDashboardDocument } from '../../src/validator.js';

const query = {
  name: 'simulated-series',
  subject: 'A synthetic day series for an interactive simulation.',
  from: 'simulation-days',
  compute: [{ as: 'score', function: 'product', args: [{ field: 'day' }, { value: 2 }] }],
  select: [{ field: 'day' }, { field: 'score' }],
  'order-by': [{ field: 'day' }]
};

describe('simulation-days intrinsic query source', () => {
  it('resolves as a typed leaf and rejects invalid fields and shadowing', () => {
    expect(resolveDashboardQuerySources([query], ['simulated-series'])).toEqual([
      'simulated-series', 'simulation-days'
    ]);
    expect(compileDashboardQueryTypes([query])).toMatchObject({
      errors: [],
      queryFields: new Map([['simulated-series', ['day', 'score']]])
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
    expect(source.rows).toEqual(Array.from({ length: 30 }, (_, index) => ({ day: index + 1 })));
    expect(source.metadata).toMatchObject({ 'source-kind': 'synthetic', availability: 'available' });
    const projected = executeDashboardQueries([query], { 'simulation-days': source }, ['simulated-series']);
    expect(projected['simulated-series'].rows).toEqual(
      Array.from({ length: 30 }, (_, index) => ({ day: index + 1, score: (index + 1) * 2 }))
    );
    const loaded = await loadDatabaseQuerySources(
      /** @type {IDBFactory} */ (/** @type {unknown} */ (indexedDB)),
      {}, { queries: [query], sourceNames: ['simulated-series'] }
    );
    expect(loaded['simulated-series'].rows).toEqual(projected['simulated-series'].rows);
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
            id: 'day-count',
            data: { source: 'simulated-series' },
            mark: 'metric',
            encoding: { value: { field: 'day', aggregate: 'count' } }
          }]
        }]
      }
    };
    const result = validateDashboardDocument(JSON.stringify(document));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
