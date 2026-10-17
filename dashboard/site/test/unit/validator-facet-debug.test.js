// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  const module = await import('../../src/validator-facet.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const view = { mark: 'chart', facet: { field: 'secret-field-name', type: 'bogus' } };

describe('validator-facet debug logging', () => {
  it('is disabled by default', async () => {
    const { validateChartFacet, output } = await load('');
    validateChartFacet(view, undefined, 'views[0]', []);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('stays silent for views without faceting', async () => {
    const { validateChartFacet, output } = await load('?debug=validator-facet');
    validateChartFacet({ mark: 'chart' }, undefined, 'views[0]', []);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar metadata only for the validator-facet category', async () => {
    const { validateChartFacet, output } = await load('?debug=validator-facet');
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const errors = [];
    validateChartFacet(view, undefined, 'views[0]', errors);
    expect(output.debug).toHaveBeenCalledTimes(1);
    const [label, metadata] = output.debug.mock.calls[0];
    expect(label).toBe('[cao:validator-facet]');
    expect(metadata).toEqual({ event: 'facet-validated', status: 'rejected', errorCount: errors.length });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('secret-field-name');
  });

  it('is excluded by other category filters', async () => {
    const { validateChartFacet, output } = await load('?debug=data');
    validateChartFacet(view, undefined, 'views[0]', []);
    expect(output.debug).not.toHaveBeenCalled();
  });
});
