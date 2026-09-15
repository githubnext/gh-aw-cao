import { describe, expect, it } from 'vitest';
import { tidy } from '../../src/data-operations.js';
import { processDataRequest } from '../../src/data-worker.js';

describe('dashboard data operations', () => {
  const rows = [
    { repository: 'bravo', status: 'open', score: 2 },
    { repository: 'alpha', status: 'closed', score: 4 },
    { repository: 'charlie', status: 'open', score: 6 }
  ];

  it('filters and arranges rows using serializable operators', () => {
    expect(tidy(rows, [
      { op: 'filter', predicates: [{ field: 'status', equals: 'open' }] },
      { op: 'arrange', by: [{ field: 'repository', direction: 'asc' }] }
    ])).toEqual([
      { repository: 'bravo', status: 'open', score: 2 },
      { repository: 'charlie', status: 'open', score: 6 }
    ]);
  });

  it('summarizes groups and computes means without mutating its input', () => {
    expect(tidy(rows, [{
      op: 'summarize',
      by: ['status'],
      values: [
        { field: 'repository', as: 'repositories', reducer: 'count' },
        { field: 'score', as: 'mean-score', reducer: 'mean' }
      ]
    }])).toEqual([
      { status: 'open', repositories: 2, 'mean-score': 4 },
      { status: 'closed', repositories: 1, 'mean-score': 4 }
    ]);
    expect(rows.map((row) => row.repository)).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('builds a Monday-to-Sunday rhythm with prior-week baselines for future days', () => {
    const reference = '2026-09-09T12:00:00Z';
    const activity = [
      { at: '2026-09-07T08:00:00Z', conclusion: 'success' },
      { at: '2026-09-08T08:00:00Z', conclusion: 'failure' },
      { at: '2026-09-09T08:00:00Z', conclusion: 'success' },
      { at: '2026-09-03T08:00:00Z', conclusion: 'success' },
      { at: '2026-09-04T08:00:00Z', conclusion: 'success' },
      { at: '2026-08-28T08:00:00Z', conclusion: 'success' }
    ];

    const result = tidy(activity, [
      {
        op: 'compute',
        values: [{
          as: 'point',
          function: 'calendar-week-point',
          args: [{ field: 'at' }, { value: reference }, { field: 'conclusion' }]
        }]
      },
      { op: 'summarize', values: [{ field: 'point', as: 'rhythm', reducer: 'calendar-week-rhythm' }] }
    ]);

    expect(result[0]?.rhythm).toEqual({
      days: [
        { label: 'Mon', date: '2026-09-07', current: 1, previous: 0, reached: true },
        { label: 'Tue', date: '2026-09-08', current: 0, previous: 0, reached: true },
        { label: 'Wed', date: '2026-09-09', current: 1, previous: 0, reached: true },
        { label: 'Thu', date: '2026-09-10', current: 0, previous: 1, reached: false },
        { label: 'Fri', date: '2026-09-11', current: 0, previous: 1, reached: false },
        { label: 'Sat', date: '2026-09-12', current: 0, previous: 0, reached: false },
        { label: 'Sun', date: '2026-09-13', current: 0, previous: 0, reached: false }
      ]
    });
  });

  it('supports text search, alternatives, limits, and the worker request shape', () => {
    expect(processDataRequest({
      data: rows,
      operators: [
        {
          op: 'filter',
          search: { fields: ['repository'], query: 'a' },
          predicates: [{ field: 'status', in: ['open', 'unknown'] }]
        },
        { op: 'arrange', by: [{ field: 'score', direction: 'desc' }] },
        { op: 'slice', limit: 1 }
      ]
    })).toEqual([{ repository: 'charlie', status: 'open', score: 6 }]);
  });

  it('appends grouped linear predictions and forecasts rows without targets', () => {
    const observations = [
      { series: 'a', x: 1, y: 3 },
      { series: 'a', x: 2, y: 5 },
      { series: 'a', x: 3, y: null },
      { series: 'b', x: 1, y: 12 },
      { series: 'b', x: 2, y: 14 }
    ];
    const result = tidy(observations, [{
      op: 'predict',
      values: [{ field: 'y', on: 'x', method: 'linear', groupby: ['series'], as: 'predicted-y' }]
    }]);

    result.forEach((row, index) => {
      expect(row['predicted-y']).toBeCloseTo([3, 5, 7, 12, 14][index], 10);
    });
    expect(observations.every((row) => !('predicted-y' in row))).toBe(true);
  });

  it('supports Vega regression method names with finite, null-safe output', () => {
    const cases = [
      { method: 'log', rows: [1, 2, 4].map((x) => ({ x, y: 3 + 2 * Math.log(x) })), x: 8, expected: 3 + 2 * Math.log(8) },
      { method: 'exp', rows: [0, 1, 2].map((x) => ({ x, y: 2 * Math.exp(0.5 * x) })), x: 3, expected: 2 * Math.exp(1.5) },
      { method: 'pow', rows: [1, 2, 3].map((x) => ({ x, y: 3 * x ** 2 })), x: 4, expected: 48 },
      { method: 'quad', rows: [0, 1, 2].map((x) => ({ x, y: x ** 2 + 2 * x + 1 })), x: 3, expected: 16 },
      { method: 'poly', order: 3, rows: [0, 1, 2, 3].map((x) => ({ x, y: x ** 3 - x + 2 })), x: 4, expected: 62 }
    ];

    for (const testCase of cases) {
      const rows = [...testCase.rows, { x: testCase.x, y: null }];
      const result = tidy(rows, [{
        op: 'predict',
        values: [{
          field: 'y',
          on: 'x',
          method: /** @type {import('../../src/data-operations.js').PredictionMethod} */ (testCase.method),
          ...(testCase.order ? { order: testCase.order } : {}),
          as: 'prediction'
        }]
      }]);
      expect(result.at(-1)?.prediction).toBeCloseTo(testCase.expected, 8);
    }

    expect(tidy([{ x: 1, y: 2 }], [{
      op: 'predict',
      values: [{ field: 'y', on: 'x', method: 'linear', as: 'prediction' }]
    }])[0].prediction).toBeNull();
  });

  it('supports multivariate linear prediction', () => {
    const rows = [
      { x: 0, z: 0, y: 1 },
      { x: 1, z: 0, y: 3 },
      { x: 0, z: 1, y: 4 },
      { x: 2, z: 3, y: null }
    ];
    const result = tidy(rows, [{
      op: 'predict',
      values: [{ field: 'y', on: ['x', 'z'], as: 'prediction' }]
    }]);
    expect(result.at(-1)?.prediction).toBeCloseTo(14, 10);
  });

  it('centers polynomial predictors to preserve large-magnitude forecasts', () => {
    const base = 1_700_000_000;
    const rows = [0, 1, 2, 3].map((offset) => ({
      x: base + offset,
      y: offset ** 3 - offset + 2
    }));
    rows.push({ x: base + 4, y: /** @type {any} */ (null) });

    const result = tidy(rows, [{
      op: 'predict',
      values: [{ field: 'y', on: 'x', method: 'poly', order: 3, as: 'prediction' }]
    }]);
    expect(result.at(-1)?.prediction).toBeCloseTo(62, 8);
  });

  it('rejects malformed worker requests', () => {
    expect(() => processDataRequest({ data: rows, operators: null })).toThrow(
      'Data worker requests require data and operators arrays.'
    );
    expect(() => tidy(rows, [/** @type {any} */ ({ op: 'execute' })])).toThrow(
      'Unsupported data operator: execute'
    );
    expect(() => processDataRequest({
      operation: 'cluster-scatter-points',
      data: rows
    })).toThrow('Scatter clustering requests require a positive integer limit.');
  });

  it('computes table statistics and histogram bins through the worker request boundary', () => {
    expect(processDataRequest({
      operation: 'summarize-table-columns',
      columns: [{ label: 'Score', type: 'quantitative', values: [1, 2, 3] }]
    })).toEqual([{
      kind: 'quantitative',
      count: 3,
      total: 6,
      mean: 2,
      deviation: 1,
      bins: [
        { lower: 1, upper: 1.6666666666666665, count: 1 },
        { lower: 1.6666666666666665, upper: 2.333333333333333, count: 1 },
        { lower: 2.333333333333333, upper: 3, count: 1 }
      ]
    }]);
  });

  it('canonicalizes dashboard sources through the worker request boundary', () => {
    const source = {
      rows: [{ organization: 'acme', repository: 'app', visibility: 'private' }],
      metadata: {
        'artifact-generation': 'generation-a',
        'as-of': '2026-09-08T00:00:00Z'
      }
    };
    const result = /** @type {any} */ (processDataRequest({
      operation: 'canonicalize-dashboard-sources',
      sources: { repositories: source }
    }));

    expect(result.repositories).toMatchObject([{
      owner: 'acme',
      name: 'app',
      fullName: 'acme/app'
    }]);
  });

  it('clusters 100,000 scatter points to a bounded worker result while preserving series', () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    const points = Array.from({ length: 100_000 }, (_, index) => ({
      key: `point-${index}`,
      x: new Date(start + (index * 1_000)).toISOString(),
      y: index % 101,
      color: `lane-${index % 4}`,
      link: null
    }));
    const clustered = /** @type {typeof points} */ (processDataRequest({
      operation: 'cluster-scatter-points',
      data: points,
      limit: 400
    }));

    expect(clustered).toHaveLength(400);
    expect(new Set(clustered.map((point) => point.color))).toEqual(new Set([
      'lane-0',
      'lane-1',
      'lane-2',
      'lane-3'
    ]));
    expect(clustered.every((point) => Number.isFinite(Date.parse(point.x)) && Number.isFinite(point.y))).toBe(true);
  });
});
