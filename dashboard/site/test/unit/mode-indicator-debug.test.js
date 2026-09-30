import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads mode-indicator.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadModeIndicatorWithDebug(search) {
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
  const module = await import('../../src/components/mode-indicator.js');
  return { ...module, output };
}

describe('mode indicator debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { resolveModeIndicator, output } = await loadModeIndicatorWithDebug('?mode=live');

    resolveModeIndicator('?mode=live');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a resolved event under the predictable category name derived from the filename', async () => {
    const { resolveModeIndicator, output } = await loadModeIndicatorWithDebug('?debug=mode-indicator');

    expect(resolveModeIndicator('?mode=review')).toBe('review');
    expect(output.debug).toHaveBeenCalledWith('[cao:mode-indicator]', {
      event: 'resolved',
      hasRequestedValue: true,
      resolved: 'review'
    });
  });

  it('logs a resolved event of "none" when no mode value is recognized', async () => {
    const { resolveModeIndicator, output } = await loadModeIndicatorWithDebug('?debug=mode-indicator');

    expect(resolveModeIndicator('?mode=draft')).toBe('');
    expect(output.debug).toHaveBeenCalledWith('[cao:mode-indicator]', {
      event: 'resolved',
      hasRequestedValue: true,
      resolved: 'none'
    });

    expect(resolveModeIndicator('')).toBe('');
    expect(output.debug).toHaveBeenCalledWith('[cao:mode-indicator]', {
      event: 'resolved',
      hasRequestedValue: false,
      resolved: 'none'
    });
  });

  it('never logs the raw search string or other query parameters, only scalar metadata', async () => {
    const { resolveModeIndicator, output } = await loadModeIndicatorWithDebug('?debug=mode-indicator');

    resolveModeIndicator('?campaign=do-not-log-this-secret-campaign&mode=live');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('do-not-log-this-secret');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
