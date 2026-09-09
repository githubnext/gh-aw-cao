import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_QUERY_LIMITS,
  DashboardQueryCancelledError,
  createDashboardQueryBudget,
  dashboardQueryDefects,
  dashboardQueryOutputFields,
  executeDashboardQueries,
  executeDashboardQuery,
  resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { computeValue, tidy } from '../../src/data-operations.js';
import { processDataRequest } from '../../src/data-worker.js';

/**
 * @param {string} id
 * @param {Partial<Record<string, string>>} [overrides]
 * @returns {import('../../src/presenter.js').SourceMetadata}
 */
function metadata(id, overrides = {}) {
  return /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
    'source-id': id,
    'source-kind': 'published',
    'as-of': '2026-09-01T00:00:00Z',
    'retrieved-at': '2026-09-01T01:00:00Z',
    completeness: 'complete',
    freshness: 'fresh',
    availability: 'available',
    ...overrides
  });
}

/** @type {import('../../src/presenter.js').LogicalSourceInput} */
const workflows = {
  source: 'workflows',
  rows: [
    { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', package: 'aw-doctor' },
    { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'b.md' }
  ],
  metadata: metadata('workflows')
};

/** @type {import('../../src/presenter.js').LogicalSourceInput} */
const usage = {
  source: 'usage',
  rows: [
    { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', aic: 4 },
    { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', aic: 6 }
  ],
  metadata: metadata('usage', { freshness: 'stale' })
};

describe('declarative dashboard queries', () => {
  it('projects, renames, and orders rows deterministically', () => {
    const result = executeDashboardQuery(
      {
        name: 'workflow-projection',
        from: 'workflows',
        select: [{ field: 'workflow', as: 'name' }, { field: 'package' }],
        'order-by': [{ field: 'name', direction: 'desc' }]
      },
      { workflows }
    );

    expect(result.rows).toEqual([{ name: 'b.md' }, { name: 'a.md', package: 'aw-doctor' }]);
    expect(result.metadata['source-kind']).toBe('derived');
    expect(result.metadata.availability).toBe('available');
  });

  it('aggregates, joins, and computes derived fields across sources', () => {
    const derived = executeDashboardQueries(
      [
        {
          name: 'aic-totals',
          from: 'usage',
          aggregate: {
            by: ['organization', 'repository', 'workflow'],
            values: [{ field: 'aic', as: 'aic', reducer: 'sum' }]
          }
        },
        {
          name: 'inventory',
          from: 'workflows',
          joins: [{
            source: 'aic-totals',
            type: 'left',
            on: [
              { left: 'organization', right: 'organization' },
              { left: 'repository', right: 'repository' },
              { left: 'workflow', right: 'workflow' }
            ],
            fields: [{ field: 'aic', as: 'observed-aic' }]
          }],
          compute: [
            { as: 'total-aic', function: 'coalesce', args: [{ field: 'observed-aic' }, { value: 0 }] },
            { as: 'slug', function: 'concat', args: [{ field: 'organization' }, { value: '/' }, { field: 'repository' }] }
          ],
          select: [{ field: 'slug', as: 'repository' }, { field: 'workflow' }, { field: 'total-aic', as: 'aic' }],
          'order-by': [{ field: 'workflow', direction: 'asc' }]
        }
      ],
      { workflows, usage }
    );

    expect(derived.inventory.rows).toEqual([
      { repository: 'githubnext/gh-aw-cao', workflow: 'a.md', aic: 10 },
      { repository: 'githubnext/gh-aw-cao', workflow: 'b.md', aic: 0 }
    ]);
    expect(derived.inventory.metadata.freshness).toBe('stale');
    expect(derived['aic-totals'].metadata['query-name']).toBe('aic-totals');
  });

  it('drops unmatched rows for inner joins and keeps them for left joins', () => {
    const join = {
      source: 'usage-totals',
      on: [{ left: 'workflow', right: 'workflow' }],
      fields: [{ field: 'aic', as: 'aic' }]
    };
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      workflows,
      'usage-totals': { source: 'usage-totals', rows: [{ workflow: 'a.md', aic: 10 }], metadata: metadata('usage-totals') }
    };

    expect(executeDashboardQuery({ name: 'inner', from: 'workflows', joins: [{ ...join, type: 'inner' }] }, sources).rows)
      .toHaveLength(1);
    const left = executeDashboardQuery({ name: 'left', from: 'workflows', joins: [{ ...join, type: 'left' }] }, sources).rows;
    expect(left).toHaveLength(2);
    expect(left[1].aic).toBeNull();
  });

  it('rejects many-to-many expansion with an explicit query diagnostic', () => {
    const result = executeDashboardQuery(
      {
        name: 'expanding',
        from: 'workflows',
        joins: [{
          source: 'usage',
          type: 'left',
          on: [{ left: 'workflow', right: 'workflow' }],
          fields: [{ field: 'aic', as: 'aic' }]
        }]
      },
      { workflows, usage }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toBe(
      '$.dashboard.queries[expanding]: joined source "usage" contains more than one row per join key.'
    );
  });

  it('never matches null, blank, or object join keys', () => {
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [{ workflow: null }, { workflow: '  ' }, { workflow: { href: 'x' } }],
        metadata: metadata('workflows')
      },
      totals: { source: 'totals', rows: [{ workflow: null, aic: 3 }], metadata: metadata('totals') }
    };

    expect(executeDashboardQuery(
      {
        name: 'null-keys',
        from: 'workflows',
        joins: [{ source: 'totals', type: 'inner', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'aic', as: 'aic' }] }]
      },
      sources
    ).rows).toEqual([]);
  });

  it('reports an unavailable state when an input source is missing or unavailable', () => {
    const missing = executeDashboardQuery({ name: 'missing-input', from: 'runs' }, { workflows });
    expect(missing.metadata.availability).toBe('unavailable');
    expect(missing.metadata['query-diagnostic']).toBe(
      '$.dashboard.queries[missing-input]: input source "runs" is unavailable.'
    );

    const unavailable = executeDashboardQuery(
      { name: 'unavailable-input', from: 'runs' },
      { runs: { source: 'runs', rows: [], metadata: metadata('runs', { availability: 'unavailable' }) } }
    );
    expect(unavailable.metadata.availability).toBe('unavailable');
    expect(unavailable.metadata['query-diagnostic']).toContain('input source "runs" is unavailable');
  });

  it('fails closed when a query exceeds a documented row limit', () => {
    const rows = Array.from({ length: DASHBOARD_QUERY_LIMITS['max-input-rows'] + 1 }, (_, index) => ({ workflow: `w-${index}` }));
    const result = executeDashboardQuery(
      { name: 'oversized', from: 'workflows' },
      { workflows: { source: 'workflows', rows, metadata: metadata('workflows') } }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toContain('max-input-rows');
  });

  it('marks an empty derived projection as empty rather than unavailable', () => {
    const result = executeDashboardQuery(
      { name: 'empty-projection', from: 'workflows', filter: { predicates: [{ field: 'workflow', equals: 'missing.md' }] } },
      { workflows }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('empty');
    expect(result.metadata['query-diagnostic']).toBeUndefined();
  });

  it('resolves the query dependency graph without pulling unrelated sources', () => {
    const definitions = [
      { name: 'totals', from: 'usage' },
      { name: 'inventory', from: 'workflows', joins: [{ source: 'totals', on: [], fields: [] }] },
      { name: 'unrelated', from: 'findings' }
    ];

    expect(resolveDashboardQuerySources(definitions, ['inventory']).sort())
      .toEqual(['inventory', 'totals', 'usage', 'workflows']);
    expect(resolveDashboardQuerySources(definitions, ['inventory'])).not.toContain('findings');
  });

  it('executes only the requested queries and their inputs', () => {
    const derived = executeDashboardQueries(
      [
        { name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } },
        { name: 'unrelated', from: 'workflows' }
      ],
      { workflows, usage },
      ['totals']
    );

    expect(Object.keys(derived)).toEqual(['totals']);
  });

  it('rejects cyclic, self-referencing, and forward query dependencies', () => {
    const defects = dashboardQueryDefects([
      { name: 'self', from: 'self' },
      { name: 'early', from: 'late' },
      { name: 'late', from: 'workflows' },
      { name: 'left-cycle', from: 'workflows', joins: [{ source: 'right-cycle', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'workflow', as: 'joined' }] }] },
      { name: 'right-cycle', from: 'left-cycle' }
    ]);

    expect(defects.get('self')).toBe('query "self" reads itself');
    expect(defects.get('early')).toBe('input source "late" is declared after "early"');
    expect(defects.get('left-cycle')).toBe('query "left-cycle" and input source "right-cycle" form a dependency cycle');
    expect(defects.get('right-cycle')).toBe('input source "left-cycle" is a rejected query');
    expect(defects.has('late')).toBe(false);
  });

  it('rejects duplicate query names instead of resolving one arbitrarily', () => {
    const definitions = [
      { name: 'inventory', from: 'workflows' },
      { name: 'inventory', from: 'usage' }
    ];

    expect(dashboardQueryDefects(definitions).get('inventory'))
      .toBe('query name "inventory" is declared more than once');
    expect(executeDashboardQueries(definitions, { workflows, usage }).inventory.metadata.availability)
      .toBe('unavailable');
  });

  it('rejects keyless joins that would expand without bound', () => {
    const result = executeDashboardQuery(
      { name: 'cartesian', from: 'workflows', joins: [{ source: 'usage', on: [], fields: [{ field: 'aic', as: 'aic' }] }] },
      { workflows, usage }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic'])
      .toBe('$.dashboard.queries[cartesian]: join on "usage" declares no equality keys.');
  });

  it('rejects join chains and limits beyond the documented bounds', () => {
    const join = { source: 'usage', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'aic', as: 'aic' }] };
    const chained = executeDashboardQuery(
      { name: 'chained', from: 'workflows', joins: Array.from({ length: DASHBOARD_QUERY_LIMITS['max-joins'] + 1 }, () => join) },
      { workflows, usage }
    );
    expect(chained.metadata['query-diagnostic']).toContain('max-joins');

    const oversized = executeDashboardQuery(
      { name: 'oversized-limit', from: 'workflows', limit: DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1 },
      { workflows }
    );
    expect(oversized.metadata['query-diagnostic']).toContain('limit must be a positive integer');
  });

  it('executes a query graph containing a rejected query without failing the others', () => {
    const derived = executeDashboardQueries(
      [
        { name: 'cyclic', from: 'cyclic' },
        { name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }
      ],
      { workflows }
    );

    expect(derived.cyclic.metadata.availability).toBe('unavailable');
    expect(derived.cyclic.metadata['query-diagnostic']).toContain('reads itself');
    expect(derived.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
  });

  it('derives the static output field schema before execution', () => {
    const fields = dashboardQueryOutputFields(
      {
        name: 'inventory',
        from: 'workflows',
        joins: [{ source: 'totals', on: [], fields: [{ field: 'aic', as: 'observed-aic' }] }],
        compute: [{ as: 'total-aic', function: 'coalesce', args: [{ field: 'observed-aic' }, { value: 0 }] }],
        select: [{ field: 'workflow' }, { field: 'total-aic', as: 'aic' }]
      },
      (source) => (source === 'workflows' ? ['organization', 'repository', 'workflow'] : undefined)
    );

    expect(fields).toEqual(['workflow', 'aic']);
    expect(dashboardQueryOutputFields({ name: 'unknown-input', from: 'mystery' }, () => undefined)).toBeUndefined();
  });
});

describe('query cancellation, deadlines, and operation budgets', () => {
  /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */
  const totals = {
    name: 'totals',
    from: 'usage',
    aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] }
  };

  it('stops execution when the caller aborts the signal', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { signal: controller.signal }))
      .toThrow(DashboardQueryCancelledError);
  });

  it('reports an abort as a cancellation rather than a query fault', () => {
    const controller = new AbortController();
    controller.abort();
    try {
      executeDashboardQueries([totals], { usage }, undefined, { signal: controller.signal });
      expect.unreachable('cancelled execution must not return a projection');
    } catch (error) {
      expect(/** @type {DashboardQueryCancelledError} */ (error).kind).toBe('aborted');
      expect(/** @type {Error} */ (error).message).toBe('dashboard queries were cancelled');
    }
  });

  it('stops execution once the deadline elapses', () => {
    let clock = 0;
    const budget = createDashboardQueryBudget({ timeout: 60000, now: () => (clock += 40000) });

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { budget }))
      .toThrow(/max-duration-ms limit of 60000/);
  });

  it('stops a runaway computation once the operation budget is spent', () => {
    const budget = createDashboardQueryBudget({ maxOperations: 1 });

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { budget }))
      .toThrow(/max-operations budget of 1/);
  });

  it('counts the row operations a query performs', () => {
    const budget = createDashboardQueryBudget();
    executeDashboardQueries([totals], { usage }, undefined, { budget });

    expect(budget.operations).toBe(4);
  });

  it('defaults to the documented one-minute deadline and operation cap', () => {
    expect(DASHBOARD_QUERY_LIMITS['max-duration-ms']).toBe(60000);
    expect(DASHBOARD_QUERY_LIMITS['max-operations']).toBe(5000000);
  });

  it('cancels an in-flight worker request through the data worker handler', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: [totals],
      sources: { usage }
    }, controller.signal)).toThrow(DashboardQueryCancelledError);
  });
});

describe('computed field vocabulary', () => {
  /** @param {string} fn @param {unknown[]} args @param {Record<string, unknown>} [row] */
  const compute = (fn, args, row = {}) => computeValue(row, {
    as: 'value',
    function: /** @type {never} */ (fn),
    args: /** @type {never} */ (args)
  });

  it('evaluates every text function deterministically', () => {
    expect(compute('concat', [{ field: 'a' }, { value: '/' }, { field: 'b' }], { a: 'x', b: 'y' })).toBe('x/y');
    expect(compute('lower', [{ value: 'AbC' }])).toBe('abc');
    expect(compute('upper', [{ value: 'AbC' }])).toBe('ABC');
    expect(compute('title-case', [{ value: 'aw-doctor' }])).toBe('Aw Doctor');
    expect(compute('trim', [{ value: '  spaced  ' }])).toBe('spaced');
    expect(compute('url-encode', [{ value: 'a/b' }])).toBe('a%2Fb');
    expect(compute('concat', [{ field: 'missing' }, { value: 'tail' }])).toBe('tail');
  });

  it('evaluates every numeric function and returns null for unusable inputs', () => {
    expect(compute('number', [{ value: '12' }])).toBe(12);
    expect(compute('sum', [{ value: 1 }, { value: 2 }, { value: 3 }])).toBe(6);
    expect(compute('difference', [{ value: 5 }, { value: 2 }])).toBe(3);
    expect(compute('product', [{ value: 2 }, { value: 3 }])).toBe(6);
    expect(compute('quotient', [{ value: 6 }, { value: 3 }])).toBe(2);
    expect(compute('quotient', [{ value: 6 }, { value: 0 }])).toBeNull();
    expect(compute('number', [{ value: 'not-a-number' }])).toBeNull();
    expect(compute('sum', [{ field: 'missing' }, { value: 2 }])).toBeNull();
    expect(compute('sum', [{ value: true }, { value: 2 }])).toBeNull();
    expect(compute('number', [{ value: { href: 'x' } }])).toBeNull();
  });

  it('coalesces past null, blank, and object values', () => {
    expect(compute('coalesce', [{ field: 'missing' }, { value: '' }, { value: 'fallback' }])).toBe('fallback');
    expect(compute('coalesce', [{ field: 'link' }, { value: 'fallback' }], { link: { href: 'x' } })).toBe('fallback');
    expect(compute('coalesce', [{ field: 'missing' }, { field: 'also-missing' }])).toBeNull();
  });

  it('rejects functions outside the closed vocabulary', () => {
    expect(() => compute('eval', [{ value: 1 }])).toThrow(TypeError);
  });

  it('computes and selects through the serializable operator pipeline', () => {
    expect(tidy([{ a: 'x', b: 'y', drop: 'me' }], [
      { op: 'compute', values: [{ as: 'joined', function: 'concat', args: [{ field: 'a' }, { field: 'b' }] }] },
      { op: 'select', fields: [{ field: 'joined', as: 'value' }] }
    ])).toEqual([{ value: 'xy' }]);
  });

  it('executes declared queries through the data worker request handler', () => {
    const response = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: [{ name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } }],
      sources: { usage }
    }));

    expect(response.totals.rows).toEqual([{ workflow: 'a.md', aic: 10 }]);
  });
});
