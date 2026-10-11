// @vitest-environment jsdom
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

const query = { name: 'usage' };

describe('chart-facet-compiler debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('');

    compileChartFacetQuery({ mark: 'chart', encoding: { x: { field: 'day' } } }, query);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a not-faceted summary under its predictable category when enabled', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    const [compiled] = compileChartFacetQuery({ mark: 'chart', encoding: { x: { field: 'day' } } }, query);

    expect(compiled).toEqual(query);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'not-faceted', queryCount: 1 }
    );
  });

  it('logs a faceted-layer summary for layered views', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    const view = {
      mark: 'chart',
      layer: [{}],
      encoding: { x: { field: 'day' }, facet: { field: 'repository' } }
    };
    const compiled = compileChartFacetQuery(view, query);

    expect(compiled).toHaveLength(2);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'faceted-layer', queryCount: 2 }
    );
  });

  it('logs a faceted-aggregated summary with the aggregate count', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    const view = {
      mark: 'chart',
      encoding: {
        x: { field: 'day' },
        y: { field: 'aic', aggregate: 'sum' },
        facet: { field: 'repository' }
      },
      data: { limit: 50 }
    };
    const compiled = compileChartFacetQuery(view, query);

    expect(compiled).toHaveLength(3);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'faceted-aggregated', queryCount: 3, aggregateCount: 1 }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({
      mark: 'chart',
      encoding: {
        x: { field: 'day' },
        y: { field: 'aic', aggregate: 'sum' },
        facet: { field: 'repository' }
      },
      data: { limit: 50 }
    }, query);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});
