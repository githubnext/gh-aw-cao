import { describe, expect, it, vi } from 'vitest';
import {
  bindSourceContinuations,
  continuationRequests,
  drainSourceContinuation,
  sourceContinuation
} from '../../src/data/continuation.js';
import {
  DASHBOARD_QUERY_LIMITS,
  executeDashboardQueries,
  paginateDashboardSources
} from '../../src/data/queries/declarative.js';

/** @typedef {import('../../src/presenter.js').LogicalSourceInput} LogicalSourceInput */

/**
 * @param {string} name
 * @param {Record<string, unknown>[]} rows
 * @param {number} [total]
 * @returns {LogicalSourceInput}
 */
function source(name, rows, total = rows.length) {
  return {
    source: name,
    rows,
    metadata: {
      'source-id': name,
      'source-kind': 'derived',
      'as-of': '2026-09-09T00:00:00Z',
      'retrieved-at': '2026-09-09T00:00:00Z',
      completeness: 'complete',
      freshness: 'fresh',
      availability: rows.length ? 'available' : 'empty',
      'total-row-count': total
    }
  };
}

/** @param {number} count */
const runs = (count) => Array.from(
  { length: count },
  (_, index) => ({ run: String(count - index) })
);

describe('continuation engine extensions', () => {
  it.each([
    { count: 0, limit: 2, pages: [[]], tokens: [false] },
    { count: 1, limit: 2, pages: [['1']], tokens: [false] },
    { count: 2, limit: 2, pages: [['2', '1']], tokens: [false] },
    { count: 3, limit: 2, pages: [['3', '2'], ['1']], tokens: [true, false] },
    { count: 5, limit: 2, pages: [['5', '4'], ['3', '2'], ['1']], tokens: [true, true, false] }
  ])('traverses $count rows with page size $limit', ({ count, limit, pages, tokens }) => {
    /** @type {string | undefined} */
    let continuationToken;
    for (const [index, expected] of pages.entries()) {
      /** @type {LogicalSourceInput} */
      const page = paginateDashboardSources(
        { runs: source('runs', runs(count)) },
        { runs: { limit, continuationToken } },
        'fixed-revision'
      ).runs;
      expect(page.rows.map((row) => row.run)).toEqual(expected);
      expect(Boolean(page.continuationToken)).toBe(tokens[index]);
      expect(page.metadata['total-row-count']).toBe(count);
      continuationToken = page.continuationToken;
    }
  });

  it.each([0, -1, 1.5, DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1])(
    'rejects invalid page size %s',
    (limit) => {
      expect(() => paginateDashboardSources(
        { runs: source('runs', runs(2)) },
        { runs: { limit } },
        'fixed-revision'
      )).toThrow('Pagination limit');
    }
  );

  it('keeps unpaginated and independently paginated sources isolated', () => {
    const result = paginateDashboardSources({
      runs: source('runs', runs(3)),
      usage: source('usage', [{ id: 1 }, { id: 2 }, { id: 3 }])
    }, {
      runs: { limit: 1 },
      usage: { limit: 2 }
    }, 'fixed-revision');

    expect(result.runs.rows).toEqual([{ run: '3' }]);
    expect(result.usage.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.runs.continuationToken).not.toBe(result.usage.continuationToken);
  });

  it('preserves unpaginated query output and supports rows without run ids', () => {
    const definitions = [{ name: 'names', from: 'items' }];
    const inputs = { items: source('items', [{ name: 'a' }, { name: 'b' }, { name: 'c' }]) };

    expect(executeDashboardQueries(definitions, inputs).names.rows).toHaveLength(3);
    const first = executeDashboardQueries(definitions, inputs, ['names'], {
      pagination: { names: { limit: 2 } }
    }).names;
    const second = executeDashboardQueries(definitions, inputs, ['names'], {
      pagination: { names: { limit: 2, continuationToken: first.continuationToken } }
    }).names;
    expect(first.rows).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(second.rows).toEqual([{ name: 'c' }]);
  });

  it('reanchors descending runs when newer ids are prepended and rejects a missing anchor', () => {
    const first = paginateDashboardSources(
      { runs: source('runs', runs(4)) },
      { runs: { limit: 2 } },
      'fixed-revision'
    ).runs;
    const shifted = paginateDashboardSources(
      { runs: source('runs', [{ run: '6' }, { run: '5' }, ...runs(4)]) },
      { runs: { limit: 2, continuationToken: first.continuationToken } },
      'fixed-revision'
    ).runs;

    expect(shifted.rows).toEqual([{ run: '2' }, { run: '1' }]);
    expect(() => paginateDashboardSources(
      { runs: source('runs', [{ run: '4' }, { run: '2' }, { run: '1' }]) },
      { runs: { limit: 2, continuationToken: first.continuationToken } },
      'fixed-revision'
    )).toThrow('no longer identifies a result row');
  });

  it('rejects token reuse across revisions and sources', () => {
    const first = paginateDashboardSources(
      { runs: source('runs', runs(3)) },
      { runs: { limit: 1 } },
      'revision-a'
    ).runs;

    for (const [name, revision] of [['runs', 'revision-b'], ['usage', 'revision-a']]) {
      expect(() => paginateDashboardSources(
        { [name]: source(name, runs(3)) },
        { [name]: { limit: 1, continuationToken: first.continuationToken } },
        revision
      )).toThrow('Invalid or stale continuation token');
    }
  });
});

describe('client continuation extensions', () => {
  it.each([
    { names: [], limit: 25, expected: {} },
    { names: ['runs'], limit: 1, expected: { runs: { limit: 1 } } },
    {
      names: ['runs', 'usage'],
      limit: 10,
      expected: { runs: { limit: 10 }, usage: { limit: 10 } }
    }
  ])('builds requests for $names', ({ names, limit, expected }) => {
    expect(continuationRequests(names, limit)).toEqual(expected);
  });

  it('binds only selected sources that expose a token', () => {
    const bound = bindSourceContinuations({
      runs: { ...source('runs', [{ run: '2' }], 2), continuationToken: 'next' },
      usage: source('usage', [{ id: 1 }])
    }, ['runs', 'usage'], async () => ({}));

    expect(sourceContinuation(bound.runs)?.token).toBe('next');
    expect(sourceContinuation(bound.usage)).toBeUndefined();
  });

  it.each([
    {
      label: 'missing source',
      response: {},
      error: 'missing source "runs"'
    },
    {
      label: 'wrong source',
      response: { runs: source('usage', []) },
      error: 'Invalid continuation response'
    },
    {
      label: 'empty token',
      response: { runs: { ...source('runs', []), continuationToken: '' } },
      error: 'Invalid continuation token'
    },
    {
      label: 'shrinking total',
      response: { runs: source('runs', [], 1) },
      error: 'Continuation data for "runs" is stale'
    },
    {
      label: 'growing total',
      response: { runs: source('runs', [], 3) },
      error: 'Continuation data for "runs" is stale'
    }
  ])('rejects a $label continuation response', async ({ response, error }) => {
    const bound = bindSourceContinuations({
      runs: { ...source('runs', [{ run: '2' }], 2), continuationToken: 'next' }
    }, ['runs'], async () => /** @type {Record<string, LogicalSourceInput>} */ (response)).runs;

    await expect(bound.loadContinuation?.('next')).rejects.toThrow(error);
  });

  it('allows retry after failure and rejects replay after advancement', async () => {
    const loadPage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        runs: { ...source('runs', [{ run: '1' }], 2), continuationToken: 'final' }
      });
    const bound = bindSourceContinuations({
      runs: { ...source('runs', [{ run: '2' }], 2), continuationToken: 'next' }
    }, ['runs'], loadPage).runs;

    await expect(bound.loadContinuation?.('next')).rejects.toThrow('temporary failure');
    await expect(bound.loadContinuation?.('next')).resolves.toMatchObject({
      rows: [{ run: '1' }],
      continuationToken: 'final'
    });
    await expect(bound.loadContinuation?.('next'))
      .rejects.toThrow('Continuation token for "runs" is not current.');
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it('drains every remaining continuation page so a chart sees the complete result set', async () => {
    const allRows = runs(5);
    /** @param {Record<string, { limit: number, continuationToken?: string }>} pagination */
    const loadPage = (pagination) => Promise.resolve(paginateDashboardSources(
      { runs: source('runs', allRows) },
      pagination,
      'fixed-revision'
    ));
    const firstPage = (await loadPage({ runs: { limit: 2 } })).runs;
    const bound = bindSourceContinuations(
      { runs: firstPage },
      ['runs'],
      (_names, pagination) => loadPage(pagination)
    ).runs;

    // The first page alone (what a chart would see without draining) is
    // truncated to the pagination limit -- exactly the bug this guards against.
    expect(firstPage.rows).toEqual([{ run: '5' }, { run: '4' }]);

    const drained = await drainSourceContinuation(bound);

    expect(drained.rows.map((row) => row.run)).toEqual(['5', '4', '3', '2', '1']);
    expect(drained.continuationToken).toBeUndefined();
    expect(sourceContinuation(drained)).toBeUndefined();
  });

  it('returns the source unchanged when it has no continuation to drain', async () => {
    const complete = source('runs', runs(2));
    await expect(drainSourceContinuation(complete)).resolves.toBe(complete);
  });
});
