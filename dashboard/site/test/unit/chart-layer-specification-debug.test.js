// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import contract from '../fixtures/chart-layer-contract.json' with { type: 'json' };

const view = contract.dashboard.pages[0].views[0];

/**
 * Loads chart-layer-specification.js with a stubbed debug output so
 * assertions can inspect emitted metadata without depending on module state
 * left over from other tests.
 * @param {string} search
 */
async function loadChartLayerSpecificationWithDebug(search) {
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
  const module = await import('../../src/chart-layer-specification.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('chart-layer-specification debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { resolveChartLayers, output } = await loadChartLayerSpecificationWithDebug('');

    resolveChartLayers(view);
    expect(() => resolveChartLayers({ ...view, layer: [] })).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a successful resolution with the layer count under its predictable category', async () => {
    const { resolveChartLayers, output } = await loadChartLayerSpecificationWithDebug('?debug=chart-layer-specification');

    const resolved = resolveChartLayers(view);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-layer-specification]',
      { operation: 'resolve-chart-layers', status: 'resolved', layerCount: resolved.length }
    );
  });

  it('logs a rejection with the offending path and no layer count', async () => {
    const { resolveChartLayers, output } = await loadChartLayerSpecificationWithDebug('?debug=chart-layer-specification');

    expect(() => resolveChartLayers({ ...view, layer: [] })).toThrow();
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:chart-layer-specification]',
      { operation: 'resolve-chart-layers', status: 'rejected', path: 'layer' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { resolveChartLayers, output } = await loadChartLayerSpecificationWithDebug('?debug=chart-layer-specification');

    resolveChartLayers(view);
    try { resolveChartLayers({ ...view, layer: [] }); } catch { /* exercised for logging only */ }

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
