import { describe, expect, it } from 'vitest';
import { compileDashboardQueryTypes } from '../../src/query-type-checker.js';

const query = (value) => ({ intent: 'Exercise static query reference checking.', ...value });

describe('dashboard query type checker', () => {
  it('compiles transitive table and query schemas through every field-producing clause', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'usage-by-workflow',
        from: 'usage',
        aggregate: {
          by: ['workflow'],
          values: [{ field: 'aic', as: 'total-aic', reducer: 'sum' }]
        }
      }),
      query({
        name: 'active-workflow-costs',
        from: 'workflows',
        joins: [{
          source: 'usage-by-workflow',
          on: [{ left: 'workflow', right: 'workflow' }],
          fields: [{ field: 'total-aic', as: 'observed-aic' }]
        }],
        compute: [{
          as: 'normalized-aic',
          function: 'number',
          args: [{ field: 'observed-aic' }]
        }],
        predict: [{
          field: 'normalized-aic',
          on: 'normalized-aic',
          as: 'predicted-aic'
        }],
        select: [
          { field: 'workflow', as: 'workflow-name' },
          { field: 'predicted-aic' }
        ],
        'order-by': [{ field: 'predicted-aic' }]
      })
    ]);

    expect(result.errors).toEqual([]);
    expect(result.queryFields.get('usage-by-workflow')).toEqual(['workflow', 'total-aic']);
    expect(result.queryFields.get('active-workflow-costs')).toEqual(['workflow-name', 'predicted-aic']);
    expect([...result.querySources.get('active-workflow-costs')].sort()).toEqual(['usage', 'workflows']);
  });

  it('rejects unknown tables, forward references, self references, and dependency cycles', () => {
    const unknown = compileDashboardQueryTypes([query({ name: 'unknown-input', from: 'deployments' })]);
    expect(unknown.errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E005',
      path: '$.dashboard.queries[0].from'
    }));

    const graph = compileDashboardQueryTypes([
      query({ name: 'first', from: 'second' }),
      query({ name: 'second', from: 'first' }),
      query({ name: 'self', from: 'self' })
    ]);
    expect(graph.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].from' }),
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].from' }),
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[2].from' })
    ]));
  });

  it('rejects duplicate query symbols and canonical table shadowing', () => {
    const result = compileDashboardQueryTypes([
      query({ name: 'runs', from: 'runs' }),
      query({ name: 'summary', from: 'runs' }),
      query({ name: 'summary', from: 'usage' })
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].name' }),
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[2].name' })
    ]));
  });

  it.each([
    ['join left', { joins: [{ source: 'usage', on: [{ left: 'missing', right: 'workflow' }], fields: [{ field: 'aic', as: 'joined-aic' }] }] }, '.joins[0].on[0].left'],
    ['join right', { joins: [{ source: 'usage', on: [{ left: 'workflow', right: 'missing' }], fields: [{ field: 'aic', as: 'joined-aic' }] }] }, '.joins[0].on[0].right'],
    ['join field', { joins: [{ source: 'usage', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'missing', as: 'joined-aic' }] }] }, '.joins[0].fields[0].field'],
    ['filter', { filter: { predicates: [{ field: 'missing', equals: true }] } }, '.filter.predicates[0].field'],
    ['compute', { compute: [{ as: 'computed', function: 'trim', args: [{ field: 'missing' }] }] }, '.compute[0].args[0].field'],
    ['aggregate group', { aggregate: { by: ['missing'], values: [{ field: 'workflow', as: 'count', reducer: 'count' }] } }, '.aggregate.by[0]'],
    ['aggregate value', { aggregate: { values: [{ field: 'missing', as: 'count', reducer: 'count' }] } }, '.aggregate.values[0].field'],
    ['aggregate filter', { aggregate: { values: [{ field: 'workflow', as: 'count', reducer: 'count', filter: { predicates: [{ field: 'missing', equals: true }] } }] } }, '.aggregate.values[0].filter.predicates[0].field'],
    ['prediction value', { predict: [{ field: 'missing', on: 'workflow', as: 'prediction' }] }, '.predict[0].field'],
    ['prediction input', { predict: [{ field: 'workflow', on: 'missing', as: 'prediction' }] }, '.predict[0].on'],
    ['prediction group', { predict: [{ field: 'workflow', on: 'workflow', groupby: ['missing'], as: 'prediction' }] }, '.predict[0].groupby[0]'],
    ['select', { select: [{ field: 'missing' }] }, '.select[0].field'],
    ['order', { 'order-by': [{ field: 'missing' }] }, '.order-by[0].field']
  ])('checks the %s field reference', (_label, clauses, suffix) => {
    const result = compileDashboardQueryTypes([
      query({ name: 'checked-query', from: 'workflows', ...clauses })
    ]);

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E010',
      path: `$.dashboard.queries[0]${suffix}`
    }));
  });

  it('checks aliases against the schema at the exact clause boundary', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'alias-flow',
        from: 'usage',
        compute: [
          { as: 'cost', function: 'number', args: [{ field: 'aic' }] },
          { as: 'cost', function: 'number', args: [{ field: 'aic' }] }
        ],
        aggregate: {
          by: ['workflow'],
          values: [{ field: 'cost', as: 'workflow', reducer: 'sum' }]
        },
        select: [
          { field: 'workflow' },
          { field: 'workflow', as: 'workflow' }
        ]
      })
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].compute[1].as' }),
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].aggregate.values[0].as' }),
      expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].select[1].as' })
    ]));
  });

  it('preserves field kinds across aliases and rejects invalid operator use', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'typed-fields',
        from: 'runs',
        select: [
          { field: 'started-at', as: 'start' },
          { field: 'run-link', as: 'link' }
        ]
      }),
      query({
        name: 'invalid-uses',
        from: 'typed-fields',
        compute: [
          { as: 'numeric-start', function: 'number', args: [{ field: 'start' }] },
          { as: 'lower-link', function: 'lower', args: [{ field: 'link' }] }
        ]
      })
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].compute[0].args[0].field' }),
      expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].compute[1].args[0].field' })
    ]));
  });
});
