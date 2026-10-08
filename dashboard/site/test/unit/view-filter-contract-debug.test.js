import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads view-filter-contract.js with a stubbed debug output so assertions
 * can inspect emitted metadata without depending on module state left over
 * from other tests.
 * @param {string} search
 */
async function loadViewFilterContractWithDebug(search) {
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
  const module = await import('../../src/view-filter-contract.js');
  return { ...module, output };
}

describe('view-filter-contract debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('');

    normalizeViewFilters({ 'view-a': { 'field-a': ['value-a'] } });
    normalizeViewFilters('not-a-mapping');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "view-filter-contract" category derived from the filename, not enabled by unrelated categories', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('?debug=some-other-category');

    normalizeViewFilters({ 'view-a': { 'field-a': ['value-a'] } });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a rejection reason when the value is not a mapping', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('?debug=view-filter-contract');

    const result = normalizeViewFilters('not-a-mapping');

    expect(result).toBeUndefined();
    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-contract]', {
      event: 'view-filters-rejected',
      reason: 'not-a-mapping'
    });
  });

  it('does not log when the value is undefined', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('?debug=view-filter-contract');

    const result = normalizeViewFilters(undefined);

    expect(result).toBeUndefined();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a normalized-outcome summary with the view counts', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('?debug=view-filter-contract');

    normalizeViewFilters({
      'view-a': { 'field-a': ['value-a'] },
      'view-b': { 'field-b': [] }
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-contract]', {
      event: 'view-filters-normalized',
      viewCount: 2,
      retainedViewCount: 1
    });
  });

  it('never logs field names, source identifiers, or other row content, only scalar metadata', async () => {
    const { normalizeViewFilters, output } = await loadViewFilterContractWithDebug('?debug=view-filter-contract');

    normalizeViewFilters({
      'secret-view-id': { 'secret-field-name': ['secret-value'] }
    });

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-view-id');
      expect(JSON.stringify(payload)).not.toContain('secret-field-name');
      expect(JSON.stringify(payload)).not.toContain('secret-value');
    }
  });
});
