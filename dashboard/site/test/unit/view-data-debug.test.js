import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

describe('view-data debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { prepareTableRows, buildChartPoints, prepareChartPoints } = await import('../../src/components/view-data.js');

    prepareTableRows([{ a: 1 }], [{ field: 'a' }], {});
    const points = buildChartPoints('page', 'title', [{ x: 'a', y: 1 }], { field: 'x' }, { field: 'y' }, null, null);
    prepareChartPoints(points, { field: 'x' }, { field: 'y' }, null, {});

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs prepare-table-rows with predictable category and scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-data');
    const { prepareTableRows } = await import('../../src/components/view-data.js');

    prepareTableRows([{ a: 1 }, { a: 2 }], [{ field: 'a' }], { limit: 1 });

    expect(debugFn).toHaveBeenCalledWith('[cao:view-data]', {
      operation: 'prepare-table-rows',
      inputRows: 2,
      outputRows: 1,
      aggregated: false,
      limited: true
    });
  });

  it('logs build-chart-points for aggregated rows with pageId and aggregate name', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-data');
    const { buildChartPoints } = await import('../../src/components/view-data.js');

    buildChartPoints(
      'overview',
      'chart',
      [{ x: 'a', y: 1 }, { x: 'a', y: 2 }],
      { field: 'x' },
      { field: 'y', aggregate: 'sum' },
      null,
      null
    );

    expect(debugFn).toHaveBeenCalledWith('[cao:view-data]', {
      operation: 'build-chart-points',
      pageId: 'overview',
      inputRows: 2,
      outputPoints: 1,
      aggregate: 'sum'
    });
  });

  it('logs prepare-chart-points with ordering and limiting outcome', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-data');
    const { prepareChartPoints } = await import('../../src/components/view-data.js');

    const points = [
      { key: '1', x: 'b', y: 1, weight: 1, category: 'b', color: null, section: null, highlighted: null, link: null, source: { x: 'b' } },
      { key: '2', x: 'a', y: 2, weight: 1, category: 'a', color: null, section: null, highlighted: null, link: null, source: { x: 'a' } }
    ];

    prepareChartPoints(points, { field: 'x' }, { field: 'y' }, null, { 'order-by': [{ field: 'x' }], limit: 1 });

    expect(debugFn).toHaveBeenCalledWith('[cao:view-data]', {
      operation: 'prepare-chart-points',
      inputPoints: 2,
      outputPoints: 1,
      ordered: true,
      limited: true
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-data');
    const { prepareTableRows, buildChartPoints, prepareChartPoints } = await import('../../src/components/view-data.js');

    prepareTableRows([{ a: 1 }], [{ field: 'a' }], {});
    const points = buildChartPoints('page', 'title', [{ x: 'a', y: 1 }], { field: 'x' }, { field: 'y' }, null, null);
    prepareChartPoints(points, { field: 'x' }, { field: 'y' }, null, {});

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
