import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads styles.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadStylesWithDebug(search) {
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
  const module = await import('../../src/styles.js');
  return { ...module, output };
}

describe('styles debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { primerStylesheet, notificationStylesheet, output } = await loadStylesWithDebug('');

    primerStylesheet();
    notificationStylesheet();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a minified event under the predictable category name derived from the filename', async () => {
    const { primerStylesheet, output } = await loadStylesWithDebug('?debug=styles');

    const result = primerStylesheet();

    expect(typeof result).toBe('string');
    expect(output.debug).toHaveBeenCalledTimes(1);
    const [category, payload] = output.debug.mock.calls[0];
    expect(category).toBe('[cao:styles]');
    expect(payload.event).toBe('minified');
    expect(typeof payload.inputLength).toBe('number');
    expect(typeof payload.outputLength).toBe('number');
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.outputLength).toBeLessThanOrEqual(payload.inputLength);
  });

  it('logs a separate minified event for the notification stylesheet', async () => {
    const { notificationStylesheet, output } = await loadStylesWithDebug('?debug=styles');

    notificationStylesheet();

    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:styles]', expect.objectContaining({ event: 'minified' }));
  });

  it('never logs raw CSS content, only scalar metadata', async () => {
    const { primerStylesheet, output } = await loadStylesWithDebug('?debug=styles');

    primerStylesheet();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
