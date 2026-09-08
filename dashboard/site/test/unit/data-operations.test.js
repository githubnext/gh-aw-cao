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
      mean: 2,
      deviation: 1,
      bins: [
        { lower: 1, upper: 1.6666666666666665, count: 1 },
        { lower: 1.6666666666666665, upper: 2.333333333333333, count: 1 },
        { lower: 2.333333333333333, upper: 3, count: 1 }
      ]
    }]);
  });

  it('derives detailed data health through the worker request boundary', () => {
    const sources = {
      runs: {
        source: 'runs',
        rows: [{ organization: 'acme', repository: 'app', run: '42', attempts: 1 }],
        metadata: {
          'source-id': 'runs',
          'source-kind': 'fixture',
          'as-of': '2026-09-08T00:00:00Z',
          'retrieved-at': '2026-09-08T00:00:00Z',
          completeness: 'complete',
          freshness: 'fresh',
          availability: 'available'
        }
      }
    };
    const result = /** @type {any} */ (processDataRequest({
      operation: 'derive-data-health',
      sources,
      context: { githubUrlBase: 'https://github.com', dashboardRepository: 'acme/app' }
    }));

    expect(result['data-health-files'].rows).toMatchObject([{ file: 'runs.json', rows: 1 }]);
    expect(result['data-health-schema'].rows).toMatchObject([{ source: 'runs', schema: '{ attempts: number, organization: string, repository: string, run: string }' }]);
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
