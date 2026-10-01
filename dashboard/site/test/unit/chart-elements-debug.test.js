import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('chart elements debug logging', () => {
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
    const { renderChartWidget } = await import('../../src/components/chart-elements.js');

    renderChartWidget('bar', [], []);
    renderChartWidget('horizontal-bar', Array.from({ length: 150 }, (_, index) => ({ x: `item-${index}`, y: index, color: null })), []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable render/empty-state/bar-limit metadata under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=chart-elements', output })
      };
    });
    vi.resetModules();
    const { renderChartWidget } = await import('../../src/components/chart-elements.js');

    const points = [
      { x: 'alpha', y: 10, color: null },
      { x: 'beta', y: 20, color: null }
    ];
    renderChartWidget('bar', points, []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-elements]',
      { event: 'render', chartType: 'bar', entryCount: 2, seriesCount: 0 }
    );

    output.debug.mockClear();
    renderChartWidget('bar', [], []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-elements]',
      { event: 'render', chartType: 'bar', entryCount: 0, seriesCount: 0 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-elements]',
      { event: 'empty-state', chartType: 'bar', reason: 'no-data', entryCount: 0 }
    );

    output.debug.mockClear();
    const oversizedPoints = Array.from({ length: 150 }, (_, index) => ({ x: `sensitive-repo-${index}`, y: index, color: null }));
    renderChartWidget('horizontal-bar', oversizedPoints, []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-elements]',
      { event: 'bar-limit-exceeded', chartType: 'horizontal-bar', pointCount: 150, limit: 100 }
    );

    // Never log the raw, potentially sensitive point values themselves.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-repo');
    }
  });
});
