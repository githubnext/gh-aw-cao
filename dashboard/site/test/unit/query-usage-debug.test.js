import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads query-usage.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadQueryUsageWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/query-usage.js');
  return { ...module, output };
}

const SAMPLE_DASHBOARD = {
  queries: [
    { name: 'used', from: 'runs' },
    { name: 'dead', from: 'runs' }
  ],
  pages: [{
    id: 'overview',
    kind: 'custom',
    views: [{ id: 'run-count', data: { source: 'used' } }]
  }]
};

describe('query-usage debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { buildDashboardQueryUsageGraph, findDeadDashboardQueries, renderDashboardQueryUsageGraph, output } =
      await loadQueryUsageWithDebug('');

    buildDashboardQueryUsageGraph(SAMPLE_DASHBOARD);
    findDeadDashboardQueries(SAMPLE_DASHBOARD);
    renderDashboardQueryUsageGraph(SAMPLE_DASHBOARD);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a predictable graph-built event under its category', async () => {
    const { buildDashboardQueryUsageGraph, output } = await loadQueryUsageWithDebug('?debug=query-usage');

    buildDashboardQueryUsageGraph(SAMPLE_DASHBOARD);

    expect(output.debug).toHaveBeenCalledWith('[cao:query-usage]', {
      event: 'graph-built',
      queryCount: 2,
      nodeCount: 3,
      rootCount: 1
    });
  });

  it('logs a dead-queries-found event with the total and dead counts', async () => {
    const { findDeadDashboardQueries, output } = await loadQueryUsageWithDebug('?debug=query-usage');

    findDeadDashboardQueries(SAMPLE_DASHBOARD);

    expect(output.debug).toHaveBeenCalledWith('[cao:query-usage]', {
      event: 'dead-queries-found',
      totalQueries: 2,
      deadCount: 1
    });
  });

  it('logs a graph-rendered event with the node and dead query counts', async () => {
    const { renderDashboardQueryUsageGraph, output } = await loadQueryUsageWithDebug('?debug=query-usage');

    renderDashboardQueryUsageGraph(SAMPLE_DASHBOARD);

    expect(output.debug).toHaveBeenCalledWith('[cao:query-usage]', {
      event: 'graph-rendered',
      nodeCount: 3,
      deadQueryCount: 1
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const { buildDashboardQueryUsageGraph, findDeadDashboardQueries, renderDashboardQueryUsageGraph, output } =
      await loadQueryUsageWithDebug('?debug=query-usage');

    buildDashboardQueryUsageGraph(SAMPLE_DASHBOARD);
    findDeadDashboardQueries(SAMPLE_DASHBOARD);
    renderDashboardQueryUsageGraph(SAMPLE_DASHBOARD);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
