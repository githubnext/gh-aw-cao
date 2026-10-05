import { describe, expect, it } from 'vitest';
import { executeDashboardQueries, dashboardQueryDefects, dashboardQueryOutputFields } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { processDataRequest } from '../../src/data-worker.js';

const order = [{ field: 'observed-at' }, { field: 'run' }];
/** @type {import('../../src/data-operations.js').WindowField[]} */
const values = [
  { field: 'aic', as: 'moving', operation: 'rolling', frame: 3, reducer: 'mean', groupby: ['workflow'], 'order-by': order },
  { field: 'aic', as: 'difference', operation: 'change', groupby: ['workflow'], 'order-by': order },
  { field: 'aic', as: 'percent', operation: 'change', mode: 'percentage', groupby: ['workflow'], 'order-by': order },
  { field: 'aic', as: 'per-second', operation: 'change', mode: 'rate', 'time-field': 'observed-at', unit: 'second', groupby: ['workflow'], 'order-by': order }
];
const query = { name: 'usage-window', subject: 'Usage trends', from: 'usage', window: values };

/** @param {Record<string, unknown>} queryDefinition */
function documentWith(queryDefinition) {
  return JSON.stringify({
    'language-version': '0.1.0',
    dashboard: {
      id: 'window-dashboard', title: 'Window dashboard', queries: [queryDefinition],
      pages: [{ id: 'usage', kind: 'custom', title: 'Usage', views: [{
        id: 'window-view', mark: 'table', title: 'Window',
        data: { source: 'usage-window' },
        encoding: { columns: [{ field: 'moving', type: 'quantitative' }] }
      }] }]
    }
  });
}

describe('declarative worker window queries', () => {
  it('computes partitioned rolling and three changes without reordering source rows', () => {
    const rows = [
      { run: '4', workflow: 'a', aic: 9, 'observed-at': '2026-01-01T00:00:04Z' },
      { run: '1', workflow: 'a', aic: 0, 'observed-at': '2026-01-01T00:00:00Z' },
      { run: '2', workflow: 'b', aic: 8, 'observed-at': '2026-01-01T00:00:01Z' },
      { run: '3', workflow: 'a', aic: 3, 'observed-at': '2026-01-01T00:00:02Z' },
      { run: '5', workflow: 'a', aic: null, 'observed-at': '2026-01-01T00:00:05Z' },
      { run: '6', workflow: 'a', aic: 12, 'observed-at': '2026-01-01T00:00:06Z' }
    ];
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      usage: { source: 'usage', rows, metadata: {
        'source-id': 'usage', 'source-kind': 'published', 'as-of': '2026-01-01T00:00:06Z',
        'retrieved-at': '2026-01-01T00:00:06Z', completeness: 'complete', freshness: 'fresh', availability: 'available'
      } }
    };
    const output = executeDashboardQueries([query], sources)['usage-window'].rows;
    expect(output.map((row) => row.run)).toEqual(rows.map((row) => row.run));
    expect(output.map(({ moving, difference, percent, 'per-second': rate }) => [moving, difference, percent, rate]))
      .toEqual([
        [4, 6, 200, 3],
        [0, null, null, null],
        [8, null, null, null],
        [1.5, 3, null, 1.5],
        [6, null, null, null],
        [10.5, null, null, null]
      ]);
    expect(rows[0]).not.toHaveProperty('moving');
    expect(dashboardQueryOutputFields(query, (name) => name === 'usage' ? ['run', 'workflow', 'aic', 'observed-at'] : undefined))
      .toContain('per-second');
  });

  it('handles equal timestamps, negative baselines, invalid time, missing values and stable ties', () => {
    const rows = [
      { id: 2, x: -2, t: '2026-01-01T00:00:00Z' },
      { id: 1, x: -4, t: '2026-01-01T00:00:00Z' },
      { id: 3, x: 2, t: 'bad' }
    ];
    const definition = { name: 'window-test', from: 'usage', window: [
      { field: 'x', as: 'delta', operation: 'change', 'order-by': [{ field: 'id' }] },
      { field: 'x', as: 'pct', operation: 'change', mode: 'percentage', 'order-by': [{ field: 'id' }] },
      { field: 'x', as: 'rate', operation: 'change', mode: 'rate', 'time-field': 't', unit: 'second', 'order-by': [{ field: 'id' }] }
    ] };
    const output = executeDashboardQueries([definition], {
      usage: { source: 'usage', rows, metadata: {
        'source-id': 'usage', 'source-kind': 'published', 'as-of': '2026-01-01T00:00:00Z',
        'retrieved-at': '2026-01-01T00:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available'
      } }
    })['window-test'].rows;
    expect(output.map((row) => [row.delta, row.pct, row.rate]))
      .toEqual([[2, -50, null], [null, null, null], [4, -200, null]]);
  });

  it('executes window results through the production data worker request boundary', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: [query],
      sources: { usage: { source: 'usage', rows: [
        { workflow: 'a', run: '1', aic: 2, 'observed-at': '2026-01-01T00:00:00Z' },
        { workflow: 'a', run: '2', aic: 8, 'observed-at': '2026-01-01T00:00:02Z' }
      ], metadata: {
        'source-id': 'usage', 'source-kind': 'published', 'as-of': '2026-01-01T00:00:02Z',
        'retrieved-at': '2026-01-01T00:00:02Z', completeness: 'complete', freshness: 'fresh', availability: 'available'
      } } }
    }));
    expect(result['usage-window'].rows.map((row) => row['per-second'])).toEqual([null, 3]);
  });

  it('uses complete centered odd windows and explicit elapsed-time units', () => {
    const rows = [1, 2, 3, 4].map((x, index) => ({
      x, t: `2026-01-01T00:0${index}:00Z`
    }));
    const definition = { name: 'centered', from: 'usage', window: [
      { field: 'x', as: 'center', operation: 'rolling', frame: 3, alignment: 'centered', 'order-by': [{ field: 't' }] },
      { field: 'x', as: 'per-minute', operation: 'change', mode: 'rate', 'time-field': 't', unit: 'minute', 'order-by': [{ field: 't' }] }
    ] };
    const output = executeDashboardQueries([definition], {
      usage: { source: 'usage', rows, metadata: {
        'source-id': 'usage', 'source-kind': 'published', 'as-of': '2026-01-01T00:00:00Z',
        'retrieved-at': '2026-01-01T00:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available'
      } }
    }).centered.rows;
    expect(output.map((row) => row.center)).toEqual([null, 2, 3, null]);
    expect(output.map((row) => row['per-minute'])).toEqual([null, 1, 1, 1]);
  });

  it('validates window schema, field types and bounded shape, including bypassed validators', () => {
    expect(validateDashboardDocument(documentWith(query)).ok).toBe(true);
    /** @type {Array<[Record<string, unknown>, string]>} */
    const cases = [
      [{ ...values[0], frame: 0 }, '.frame'],
      [{ ...values[0], frame: 1001 }, '.frame'],
      [{ ...values[0], reducer: 'median' }, '.reducer'],
      [{ ...values[0], frame: 4, alignment: 'centered' }, '.frame'],
      [{ ...values[0], alignment: 'offset' }, '.alignment'],
      [{ ...values[0], field: 'observed-at' }, '.field'],
      [{ ...values[0], as: 'aic' }, '.as'],
      [{ ...values[2], mode: 'rate' }, '.time-field'],
      [{ ...values[3], 'time-field': 'aic' }, '.time-field'],
      [{ ...values[3], unit: 'week' }, '.unit'],
      [{ ...values[1], 'order-by': [] }, '.order-by'],
      [{ ...values[1], unknown: true }, '.unknown']
    ];
    for (const [entry, invalidPath] of cases) {
      const invalid = { ...query, window: [entry] };
      const result = validateDashboardDocument(documentWith(invalid));
      expect(result.ok, JSON.stringify(entry)).toBe(false);
      expect(result.errors.some((error) => error.path.endsWith(invalidPath)), JSON.stringify(result.errors)).toBe(true);
    }
    expect(dashboardQueryDefects([{ ...query, window: [{ ...values[0], frame: 1001 }] }]).has(query.name)).toBe(true);
    expect(dashboardQueryDefects([{ ...query, window: [values[0], values[0]] }]).has(query.name)).toBe(true);
  });

  it('does not push view predicates ahead of the window calculation', () => {
    const compiled = compileDashboardViewPayloadQueries(
      { views: [{ id: 'sample', mark: 'table', data: { source: 'usage-window', filters: { workflow: ['a'] } } }] },
      'sample', { queries: [query] }
    );
    expect(compiled.queries[0].window).toEqual(values);
    expect(compiled.queries[0].filter).toBeUndefined();
    expect(compiled.queries[1].filter).toBeDefined();
  });
});
