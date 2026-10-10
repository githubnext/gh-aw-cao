// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads data/queries/facet.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadFacetWithDebug(search) {
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
  const module = await import('../../src/data/queries/facet.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('facet debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { partitionFacetRows, output } = await loadFacetWithDebug('');

    partitionFacetRows([{ repo: 'a' }, { repo: 'b' }], { field: 'repo', as: 'rows' });
    expect(() => partitionFacetRows([{ repo: {} }], { field: 'repo', as: 'rows' })).toThrow(TypeError);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a completed summary under its predictable category when enabled', async () => {
    const { partitionFacetRows, output } = await loadFacetWithDebug('?debug=facet');

    const rows = [{ repo: 'a' }, { repo: 'a' }, { repo: 'b' }];
    partitionFacetRows(rows, { field: 'repo', as: 'rows' });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:facet]',
      { operation: 'partition', status: 'completed', inputRows: 3, panelCount: 2 }
    );
  });

  it('logs a rejected summary when a category value is non-scalar', async () => {
    const { partitionFacetRows, output } = await loadFacetWithDebug('?debug=facet');

    expect(() => partitionFacetRows([{ repo: { nested: true } }], { field: 'repo', as: 'rows' })).toThrow(TypeError);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:facet]',
      { operation: 'partition', status: 'rejected-non-scalar-category', field: 'repo' }
    );
  });

  it('logs a rejected summary when the panel count exceeds the limit', async () => {
    const { partitionFacetRows, output } = await loadFacetWithDebug('?debug=facet');

    const rows = Array.from({ length: 65 }, (_, index) => ({ repo: `repo-${index}` }));
    expect(() => partitionFacetRows(rows, { field: 'repo', as: 'rows' })).toThrow(RangeError);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:facet]',
      { operation: 'partition', status: 'rejected-too-many-panels', panelCount: 64 }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { partitionFacetRows, output } = await loadFacetWithDebug('?debug=facet');

    partitionFacetRows([{ repo: 'a' }, { repo: 'b' }], { field: 'repo', as: 'rows' });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});
