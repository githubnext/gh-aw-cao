// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads treemap-layout.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadTreemapLayoutWithDebug(search) {
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
  const module = await import('../../src/components/treemap-layout.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const bounds = { x: 0, y: 0, width: 100, height: 60 };

describe('treemap-layout debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { tileTreemap, output } = await loadTreemapLayoutWithDebug('');

    tileTreemap([{ index: 0, value: 1 }, { index: 1, value: 2 }], bounds);
    expect(() => tileTreemap([{ index: 0, value: -1 }], bounds)).toThrow(RangeError);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a placed summary under its predictable category when enabled', async () => {
    const { tileTreemap, output } = await loadTreemapLayoutWithDebug('?debug=treemap-layout');

    const tiles = [{ index: 0, value: 1 }, { index: 1, value: 2 }, { index: 2, value: 3 }];
    const placed = tileTreemap(tiles, bounds, { method: 'binary' });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:treemap-layout]',
      { operation: 'tile', status: 'placed', method: 'binary', tileCount: tiles.length, placedCount: placed.length }
    );
  });

  it('logs a rejected summary when tile values are invalid, without duplicating the thrown message', async () => {
    const { tileTreemap, output } = await loadTreemapLayoutWithDebug('?debug=treemap-layout');

    expect(() => tileTreemap([{ index: 0, value: 0 }, { index: 1, value: 2 }], bounds)).toThrow(RangeError);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:treemap-layout]',
      { operation: 'tile', status: 'rejected-invalid-values', tileCount: 2 }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { tileTreemap, output } = await loadTreemapLayoutWithDebug('?debug=treemap-layout');

    tileTreemap([{ index: 0, value: 1 }, { index: 1, value: 2 }], bounds, { method: 'slicedice' });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
