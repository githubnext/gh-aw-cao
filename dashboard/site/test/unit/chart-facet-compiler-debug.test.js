// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const baseQuery = { name: 'runs' };

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

describe('chart-facet-compiler debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('');

    compileChartFacetQuery({ mark: 'chart' }, baseQuery);
    compileChartFacetQuery({ mark: 'chart', facet: { field: 'repo' }, layer: [{}] }, baseQuery);
    compileChartFacetQuery({
      mark: 'chart',
      facet: { field: 'repo' },
      encoding: { x: { field: 'date' }, y: { field: 'count', aggregate: 'sum' } }
    }, baseQuery);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a passthrough outcome under its predictable category when no facet is declared', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({ mark: 'chart' }, baseQuery);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'passthrough' }
    );
  });

  it('logs a layer outcome with the facet channel count when the view is layered', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({ mark: 'chart', facet: { field: 'repo' }, layer: [{}] }, baseQuery);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'layer', facetChannelCount: 1 }
    );
  });

  it('logs a faceted outcome with aggregate and order-by counts when aggregating', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({
      mark: 'chart',
      facet: { field: 'repo' },
      encoding: { x: { field: 'date' }, y: { field: 'count', aggregate: 'sum' } }
    }, baseQuery);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-facet-compiler]',
      { operation: 'compile', status: 'faceted', aggregateCount: 1, orderByCount: 2 }
    );
  });

  it('never includes query names, field values, or compiled query definitions in logged metadata', async () => {
    const { compileChartFacetQuery, output } = await loadChartFacetCompilerWithDebug('?debug=chart-facet-compiler');

    compileChartFacetQuery({
      mark: 'chart',
      facet: { field: 'repo' },
      encoding: { x: { field: 'date' }, y: { field: 'count', aggregate: 'sum' } }
    }, { name: 'sensitive-query-name' });

    for (const call of output.debug.mock.calls) {
      const payload = call[1];
      expect(payload).not.toHaveProperty('name');
      expect(payload).not.toHaveProperty('field');
      expect(JSON.stringify(payload)).not.toContain('sensitive-query-name');
    }
  });
});
