// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads data-state.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadDataStateWithDebug(search) {
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
  const module = await import('../../src/components/data-state.js');
  return { ...module, output };
}

describe('data-state debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { renderDataStateMetrics, output } = await loadDataStateWithDebug('');

    renderDataStateMetrics({ availability: 'unavailable', completeness: 'unknown', freshness: 'unknown' });
    renderDataStateMetrics(undefined);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an availability-degraded event under the predictable category derived from the filename', async () => {
    const { renderDataStateMetrics, output } = await loadDataStateWithDebug('?debug=data-state');

    renderDataStateMetrics({ availability: 'unavailable', completeness: 'unknown', freshness: 'unknown' });

    expect(output.debug).toHaveBeenCalledWith('[cao:data-state]', {
      event: 'availability-degraded',
      availability: 'unavailable'
    });
  });

  it('does not log when availability is "available" (including the default when state is undefined)', async () => {
    const { renderDataStateMetrics, output } = await loadDataStateWithDebug('?debug=data-state');

    renderDataStateMetrics({ availability: 'available', completeness: 'complete', freshness: 'fresh' });
    renderDataStateMetrics(undefined);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('only logs scalar metadata, never raw state objects', async () => {
    const { renderDataStateMetrics, output } = await loadDataStateWithDebug('?debug=data-state');

    renderDataStateMetrics({ availability: 'empty', completeness: 'unknown', freshness: 'unknown' });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
    }
  });
});
