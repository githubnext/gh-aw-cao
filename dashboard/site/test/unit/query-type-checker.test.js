import { describe, expect, it } from 'vitest';
import { compileDashboardQueryTypes } from '../../src/query-type-checker.js';
import { dashboardQueryOutputFields } from '../../src/data/queries/declarative.js';
import { TABLE_FIELDS } from '../../src/specification.js';

/** @param {Record<string, unknown>} value */
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
    expect([...(result.queryTables.get('active-workflow-costs') ?? [])].sort()).toEqual(['usage', 'workflows']);
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

  it('preserves permissive typing for database tables without a declared schema', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'overview-query',
        from: 'overview-status',
        select: [{ field: 'runtime-provided-field' }]
      }),
      query({
        name: 'overview-consumer',
        from: 'overview-query',
        filter: { predicates: [{ field: 'another-runtime-field', equals: true }] }
      })
    ]);

    expect(result.errors).toEqual([]);
    expect(result.queryFields.get('overview-query')).toBeUndefined();
    expect([...result.queryTables.get('overview-consumer') ?? []]).toEqual(['overview-status']);
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

  it('rejects branch-specific filters over multi-source row projections', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'safe-output-items',
        from: 'issues',
        union: ['audits'],
        filter: { predicates: [{ field: 'event-type', equals: 'safe_output.created' }] }
      }),
      query({
        name: 'issue-safe-outputs',
        from: 'safe-output-items',
        filter: { predicates: [{ field: 'is-pull-request', equals: false }] }
      })
    ]);

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E011',
      message: expect.stringContaining('filter field "is-pull-request" is only available from some row input tables'),
      path: '$.dashboard.queries[1].filter.predicates[0].field'
    }));
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

  it('infers compute result types through conditional and formatting functions', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'typed-computations',
        from: 'runs',
        compute: [
          { as: 'start', function: 'coalesce', args: [{ field: 'started-at' }, { value: null }] },
          { as: 'formatted-run', function: 'format-count', args: [{ field: 'started-at' }] },
          { as: 'after-threshold', function: 'greater-than', args: [{ field: 'started-at' }, { value: 0 }] },
          { as: 'invalid-boolean-sum', function: 'sum', args: [{ field: 'after-threshold' }, { value: 1 }] }
        ]
      }),
      query({
        name: 'typed-consumer',
        from: 'typed-computations',
        compute: [{ as: 'start-number', function: 'number', args: [{ field: 'start' }] }]
      })
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DLS-E011',
        message: 'numeric query operator cannot use field "started-at" because its inferred type is temporal.',
        path: '$.dashboard.queries[0].compute[1].args[0].field'
      }),
      expect.objectContaining({
        code: 'DLS-E011',
        path: '$.dashboard.queries[0].compute[2].args[0].field'
      }),
      expect.objectContaining({
        code: 'DLS-E011',
        message: 'numeric query operator cannot use field "after-threshold" because its inferred type is boolean.',
        path: '$.dashboard.queries[0].compute[3].args[0].field'
      }),
      expect.objectContaining({
        code: 'DLS-E011',
        path: '$.dashboard.queries[1].compute[0].args[0].field'
      })
    ]));
  });

  it('models reducer output types without inventing scalar types for structured values', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'reducer-outputs',
        from: 'runs',
        aggregate: {
          values: [
            { field: 'run-conclusion', as: 'conclusions', reducer: 'distinct-list' },
            { field: 'run-conclusion', as: 'conclusion-values', reducer: 'distinct-values' }
          ]
        }
      }),
      query({
        name: 'reducer-consumer',
        from: 'reducer-outputs',
        compute: [
          { as: 'invalid-total', function: 'sum', args: [{ field: 'conclusions' }, { value: 1 }] },
          { as: 'unknown-total', function: 'sum', args: [{ field: 'conclusion-values' }, { value: 1 }] }
        ]
      })
    ]);

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E011',
      message: 'numeric query operator cannot use field "conclusions" because its inferred type is text.',
      path: '$.dashboard.queries[1].compute[0].args[0].field'
    }));
    expect(result.errors).not.toContainEqual(expect.objectContaining({
      path: '$.dashboard.queries[1].compute[1].args[0].field'
    }));
  });

  it('retains invalid declared outputs to prevent cascading reference errors', () => {
    const result = compileDashboardQueryTypes([
      query({
        name: 'invalid-group',
        from: 'usage',
        aggregate: {
          by: ['missing-group'],
          values: [{ field: 'aic', as: 'total-aic', reducer: 'sum' }]
        }
      }),
      query({
        name: 'consumer',
        from: 'invalid-group',
        select: [{ field: 'missing-group' }, { field: 'total-aic' }]
      })
    ]);

    expect(result.queryFields.get('invalid-group')).toEqual(['missing-group', 'total-aic']);
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'DLS-E010',
      path: '$.dashboard.queries[0].aggregate.by[0]'
    }));
    expect(result.errors).not.toContainEqual(expect.objectContaining({
      path: '$.dashboard.queries[1].select[0].field'
    }));
  });

  it('matches runtime output-field inference for valid query pipelines', () => {
    const definitions = [
      {
        intent: 'Aggregate usage by workflow.',
        name: 'usage-summary',
        from: 'usage',
        aggregate: {
          by: ['workflow'],
          values: [{ field: 'aic', as: 'total-aic', reducer: /** @type {const} */ ('sum') }]
        }
      },
      {
        intent: 'Format and select the usage summary.',
        name: 'selected-summary',
        from: 'usage-summary',
        compute: [{ as: 'label', function: /** @type {const} */ ('format-count'), args: [{ field: 'total-aic' }] }],
        select: [{ field: 'workflow' }, { field: 'label', as: 'formatted-aic' }]
      }
    ];
    const runtimeFields = new Map();
    for (const definition of definitions) {
      runtimeFields.set(definition.name, dashboardQueryOutputFields(definition, (source) => (
        runtimeFields.get(source) ?? TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (source)]
      )));
    }

    const result = compileDashboardQueryTypes(definitions);
    expect(result.errors).toEqual([]);
    expect(result.queryFields).toEqual(runtimeFields);
  });

  it('reports the unresolved name and bounded available-field context', () => {
    const result = compileDashboardQueryTypes([
      query({ name: 'duplicate', from: 'workflows' }),
      query({ name: 'duplicate', from: 'usage' }),
      query({
        name: 'invalid-references',
        from: 'missing-source',
        joins: [{
          source: 'usage',
          on: [{ left: 'workflow', right: 'missing-field' }],
          fields: []
        }]
      })
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'query name "duplicate" is declared more than once.',
        path: '$.dashboard.queries[1].name'
      }),
      expect.objectContaining({
        message: 'query input "missing-source" is not a database table or previously declared query.',
        path: '$.dashboard.queries[2].from'
      }),
      expect.objectContaining({
        message: expect.stringMatching(/^field "missing-field" is not available from input "usage"; available fields: /),
        path: '$.dashboard.queries[2].joins[0].on[0].right'
      })
    ]));
  });
});
