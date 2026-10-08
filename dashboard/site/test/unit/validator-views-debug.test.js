// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads validator-views.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadValidatorViewsWithDebug(search) {
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
  const module = await import('../../src/validator-views.js');
  return { ...module, output };
}

const validMetricView = {
  id: 'run-count',
  data: { source: 'runs' },
  mark: 'metric',
  encoding: { value: { field: 'run', aggregate: 'count' } }
};

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-views debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { validateView, validateProgressiveDisclosure, output } = await loadValidatorViewsWithDebug('');

    validateView(validMetricView, null, 'views[0]', new Set(), []);
    validateView('not-a-mapping', null, 'views[0]', new Set(), []);
    validateProgressiveDisclosure([validMetricView], 'views', []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the view validation outcome with its mark under its predictable category when enabled', async () => {
    const { validateView, output } = await loadValidatorViewsWithDebug('?debug=validator-views');

    validateView(validMetricView, null, 'views[0]', new Set(), []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-views]',
      { operation: 'validate-view', mark: 'metric', status: 'ok' }
    );

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const errors = [];
    validateView({ ...validMetricView, mark: 'unknown-mark' }, null, 'views[0]', new Set(), errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-views]',
      { operation: 'validate-view', mark: 'unknown-mark', status: 'invalid' }
    );
  });

  it('logs rejection when the view is not a mapping', async () => {
    const { validateView, output } = await loadValidatorViewsWithDebug('?debug=validator-views');

    validateView('not-a-mapping', null, 'views[0]', new Set(), []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-views]',
      { operation: 'validate-view', mark: null, status: 'invalid' }
    );
  });

  it('logs the progressive disclosure outcome with essential/total view counts when enabled', async () => {
    const { validateProgressiveDisclosure, output } = await loadValidatorViewsWithDebug('?debug=validator-views');

    validateProgressiveDisclosure([validMetricView, { ...validMetricView, disclosure: 'supplemental' }], 'views', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-views]',
      { operation: 'validate-progressive-disclosure', essentialCount: 1, viewCount: 2, status: 'ok' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { validateView, validateProgressiveDisclosure, output } = await loadValidatorViewsWithDebug('?debug=validator-views');

    validateView(validMetricView, null, 'views[0]', new Set(), []);
    validateProgressiveDisclosure([validMetricView], 'views', []);

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('run-count');
      expect(JSON.stringify(payload)).not.toContain('runs');
    }
  });
});
