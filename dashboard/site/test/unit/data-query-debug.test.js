// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * @param {string} id
 * @returns {import('../../src/presenter.js').SourceMetadata}
 */
function metadata(id) {
  return /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
    'source-id': id,
    'source-kind': 'published',
    'as-of': '2026-09-01T00:00:00Z',
    'retrieved-at': '2026-09-01T01:00:00Z',
    completeness: 'complete',
    freshness: 'fresh',
    availability: 'available'
  });
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('dashboard query debug logging', () => {
  it('reports structured stage and query timings when data query debugging is enabled', async () => {
    window.history.replaceState(null, '', '/?debug=data:query');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const timestamps = [0, 1, 2, 4, 5, 8, 9, 13];
    vi.stubGlobal('performance', { now: vi.fn(() => timestamps.shift() ?? 13) });
    const { executeDashboardQuery } = await import('../../src/data/queries/declarative.js');

    const result = executeDashboardQuery({
      name: 'runs-filter-options',
      from: 'runs',
      filter: { predicates: [{ field: 'run-status', equals: 'completed' }] },
      aggregate: {
        by: [],
        values: [{ field: 'repository', as: 'repositories', reducer: 'distinct-values' }]
      }
    }, {
      runs: {
        source: 'runs',
        rows: [
          { repository: 'alpha', 'run-status': 'completed' },
          { repository: 'beta', 'run-status': 'queued' }
        ],
        metadata: metadata('runs')
      }
    });

    expect(result.rows).toEqual([{ repositories: ['alpha'] }]);
    expect(debug).toHaveBeenCalledWith('[cao:data:query]', 'stage', expect.objectContaining({
      query: 'runs-filter-options',
      stage: 'filter',
      inputRows: 2,
      outputRows: 1,
      operations: 2,
      status: 'complete'
    }));
    expect(debug).toHaveBeenCalledWith('[cao:data:query]', 'stage', expect.objectContaining({
      query: 'runs-filter-options',
      stage: 'aggregate',
      inputRows: 1,
      outputRows: 1,
      operations: 1,
      status: 'complete'
    }));
    expect(debug).toHaveBeenCalledWith('[cao:data:query]', 'query', expect.objectContaining({
      query: 'runs-filter-options',
      inputRows: { runs: 2 },
      outputRows: 1,
      operations: 5,
      status: 'available'
    }));

    const failed = executeDashboardQuery({
      name: 'runs-duplicate-join',
      from: 'runs',
      joins: [{
        source: 'usage',
        on: [{ left: 'run', right: 'run' }],
        fields: [{ field: 'aic', as: 'aic' }]
      }]
    }, {
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        metadata: metadata('runs')
      },
      usage: {
        source: 'usage',
        rows: [{ run: '1', aic: 1 }, { run: '1', aic: 2 }],
        metadata: metadata('usage')
      }
    });

    expect(failed.metadata.availability).toBe('unavailable');
    expect(debug).toHaveBeenCalledWith('[cao:data:query]', 'stage', expect.objectContaining({
      query: 'runs-duplicate-join',
      stage: 'join:usage',
      inputRows: 1,
      joinedRows: 2,
      status: 'failed'
    }));
    expect(debug).toHaveBeenCalledWith('[cao:data:query]', 'query', expect.objectContaining({
      query: 'runs-duplicate-join',
      outputRows: 0,
      status: 'unavailable',
      failure: 'joined source "usage" contains more than one row per join key'
    }));
  });

  it('does not emit query timings unless the debug category is enabled', async () => {
    window.history.replaceState(null, '', '/');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const time = vi.spyOn(console, 'time').mockImplementation(() => {});
    const timeEnd = vi.spyOn(console, 'timeEnd').mockImplementation(() => {});
    const { executeDashboardQuery } = await import('../../src/data/queries/declarative.js');

    const result = executeDashboardQuery({
      name: 'runs-table',
      from: 'runs'
    }, {
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        metadata: metadata('runs')
      }
    });
    result.rows;

    expect(debug).not.toHaveBeenCalled();
    expect(time).not.toHaveBeenCalled();
    expect(timeEnd).not.toHaveBeenCalled();
  });
});
