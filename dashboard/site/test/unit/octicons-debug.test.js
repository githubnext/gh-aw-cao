// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads octicons.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadOcticonsWithDebug(search) {
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
  const module = await import('../../src/octicons.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('octicons debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { octicon, output } = await loadOcticonsWithDebug('');

    octicon('alert');
    octicon('not-a-real-octicon-name');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs sprite parsing and unknown-name fallback under its predictable category when enabled', async () => {
    const { octicon, output } = await loadOcticonsWithDebug('?debug=octicons');

    octicon('alert');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:octicons]',
      expect.objectContaining({ event: 'sprite-parsed', symbolCount: expect.any(Number) })
    );

    output.debug.mockClear();
    octicon('not-a-real-octicon-name');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:octicons]',
      { event: 'fallback-used', requestedName: 'not-a-real-octicon-name' }
    );
  });

  it('does not log a fallback for known octicon names', async () => {
    const { octicon, output } = await loadOcticonsWithDebug('?debug=octicons');

    octicon('alert');
    output.debug.mockClear();
    octicon('check');

    expect(output.debug).not.toHaveBeenCalledWith(
      '[cao:octicons]',
      expect.objectContaining({ event: 'fallback-used' })
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { octicon, output } = await loadOcticonsWithDebug('?debug=octicons');

    octicon('alert');
    octicon('not-a-real-octicon-name');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
