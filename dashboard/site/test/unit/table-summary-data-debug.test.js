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

describe('table-summary-data debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { summarizeTableColumns, binHistogramValues } = await import('../../src/table-summary-data.js');

    summarizeTableColumns([{ label: 'Status', type: 'nominal', values: ['open'] }]);
    binHistogramValues([1, 2, 3, 4, 5]);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs summarize boundaries with column and unsummarized counts under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary-data');
    const { summarizeTableColumns } = await import('../../src/table-summary-data.js');

    summarizeTableColumns([
      { label: 'Status', type: 'nominal', values: ['open', 'closed'] },
      { label: 'Score', type: 'quantitative', values: [] },
      { label: 'Ignored', display: 'run-link', type: 'nominal', values: ['x'] }
    ]);

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary-data]', { operation: 'summarize', columnCount: 3 });
    expect(debugFn).toHaveBeenCalledWith(
      '[cao:table-summary-data]',
      { operation: 'summarize-complete', columnCount: 3, unsummarizedCount: 2 }
    );
  });

  it('logs bin-histogram with sample size and resolved bin count when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary-data');
    const { binHistogramValues } = await import('../../src/table-summary-data.js');

    binHistogramValues([1, 2, 3, 4, 5, 6, 7, 8], 4);

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary-data]', { operation: 'bin-histogram', sampleSize: 8, binCount: 4 });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary-data');
    const { summarizeTableColumns, binHistogramValues } = await import('../../src/table-summary-data.js');

    summarizeTableColumns([{ label: 'super-secret-label', type: 'nominal', values: ['super-secret-value'] }]);
    binHistogramValues([1, 2, 3]);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('super-secret');
    }
  });
});
