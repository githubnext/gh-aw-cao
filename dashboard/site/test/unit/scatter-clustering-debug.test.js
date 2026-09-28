import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {number} count @param {string} [color] */
function makePoints(count, color = 'series') {
  return Array.from({ length: count }, (_, index) => ({
    key: `point-${index}`,
    x: new Date(2024, 0, index + 1).toISOString(),
    y: index,
    color,
    link: null
  }));
}

describe('scatter clustering debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { clusterScatterPoints } = await import('../../src/scatter-clustering.js');

    clusterScatterPoints(makePoints(10), 5);
    clusterScatterPoints(makePoints(2), 5);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a skip event under its predictable category when the point count fits the limit', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=scatter-clustering', output })
      };
    });
    vi.resetModules();
    const { clusterScatterPoints } = await import('../../src/scatter-clustering.js');

    clusterScatterPoints(makePoints(3), 5);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:scatter-clustering]',
      { event: 'skipped', pointCount: 3, limit: 5 }
    );
  });

  it('logs a clustered event with series and cluster counts when reducing points', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=scatter-clustering', output })
      };
    });
    vi.resetModules();
    const { clusterScatterPoints } = await import('../../src/scatter-clustering.js');

    clusterScatterPoints(makePoints(10), 4);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:scatter-clustering]',
      { event: 'clustered', pointCount: 10, limit: 4, seriesCount: 1, clusterCount: 4 }
    );
  });

  it('logs a series-clamped event when the series count meets or exceeds the cluster limit', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=scatter-clustering', output })
      };
    });
    vi.resetModules();
    const { clusterScatterPoints } = await import('../../src/scatter-clustering.js');

    const points = [
      ...makePoints(5, 'series-a'),
      ...makePoints(5, 'series-b'),
      ...makePoints(5, 'series-c')
    ];

    clusterScatterPoints(points, 2);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:scatter-clustering]',
      { event: 'series-clamped', seriesCount: 3, limit: 2 }
    );
  });

  it('never logs point coordinates or link content, only scalar counts and limits', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=scatter-clustering', output })
      };
    });
    vi.resetModules();
    const { clusterScatterPoints } = await import('../../src/scatter-clustering.js');

    const points = makePoints(10, 'secret-series-label').map((point, index) => ({
      ...point,
      link: { href: `https://example.test/secret-path-${index}`, label: 'sensitive-link-label' }
    }));

    clusterScatterPoints(points, 3);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/secret|sensitive|example\.test/i);
    }
  });
});
