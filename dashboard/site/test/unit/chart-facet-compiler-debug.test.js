import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads data/queries/chart-facet-compiler.js with a stubbed debug output so
 * assertions can inspect emitted metadata without depending on module state
 * left over from other tests.
 * @param {string} search
 */
async function loadChartFacetCompilerWithDebug(search) {
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
  const module = await import('../../src/data/queries/chart-facet-compiler.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('chart facet compiler debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('');

    compileChartFacetQuery({ encoding: {} }, { name: 'q' });
    compileChartFacetQuery({ layer: [], facet: { field: 'repo', as: 'facet-rows' } }, { name: 'q' });
    compileChartFacetQuery(
      { facet: { field: 'repo', as: 'facet-rows' }, encoding: { x: { field: 'repo' }, y: { field: 'aic', aggregate: 'sum' } } },
      { name: 'q' }
    );

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a no-facet summary under its predictable category when the view has no facet', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({ encoding: {} }, { name: 'q' });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', outcome: 'no-facet', queryCount: 1 }
    );
  });

  it('logs a layered summary when the view declares layers', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({ layer: [], facet: { field: 'repo', as: 'facet-rows' } }, { name: 'q' });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', outcome: 'layered', channelCount: 1, queryCount: 2 }
    );
  });

  it('logs an aggregated summary when an aggregate channel is present', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery(
      { facet: { field: 'repo', as: 'facet-rows' }, encoding: { x: { field: 'repo' }, y: { field: 'aic', aggregate: 'sum' } } },
      { name: 'q' }
    );

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', outcome: 'aggregated', channelCount: 1, aggregateCount: 1, queryCount: 3 }
    );
  });

  it('logs a partitioned summary when no encoding channel aggregates', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery(
      { facet: { field: 'repo', as: 'facet-rows' }, encoding: { x: { field: 'repo' }, y: { field: 'aic' } } },
      { name: 'q' }
    );

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', outcome: 'partitioned', channelCount: 1, aggregateCount: 0, queryCount: 3 }
    );
  });

  it('never logs sensitive view or query content, only scalar metadata', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery(
      { facet: { field: 'sensitive-repo', as: 'facet-rows' }, encoding: { x: { field: 'sensitive-repo' }, y: { field: 'aic', aggregate: 'sum' } } },
      { name: 'sensitive-query-name' }
    );

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('sensitive-repo');
      expect(JSON.stringify(payload)).not.toContain('sensitive-query-name');
    }
  });
});
