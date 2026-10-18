// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function loadChartFacetWithDebug(search) {
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
  const module = await import('../../src/chart-facet.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('chart-facet debug logging', () => {
  it('is disabled by default', async () => {
    const { chartFacet, output } = await loadChartFacetWithDebug('');
    chartFacet({ facet: { field: 'a' } });
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs only scalar shape metadata under the chart-facet category', async () => {
    const { chartFacet, output } = await loadChartFacetWithDebug('?debug=chart-facet');
    chartFacet({ facet: { field: 'secret-field-name' } });
    chartFacet({ encoding: { row: { field: 'x' } } });
    chartFacet({});
    expect(output.debug.mock.calls).toEqual([
      ['[cao:chart-facet]', { event: 'facet-resolved', status: 'faceted', shape: 'field' }],
      ['[cao:chart-facet]', { event: 'facet-resolved', status: 'faceted', shape: 'row-column' }],
      ['[cao:chart-facet]', { event: 'facet-resolved', status: 'none', shape: 'none' }]
    ]);
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('secret-field-name');
  });

  it('does not log when the category is excluded', async () => {
    const { chartFacet, output } = await loadChartFacetWithDebug('?debug=*,-chart-facet');
    chartFacet({});
    expect(output.debug).not.toHaveBeenCalled();
  });
});
