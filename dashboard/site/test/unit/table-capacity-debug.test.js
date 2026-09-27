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

describe('table capacity debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { tableRowLimitForEnvironment, logTableCapacityDecision, applyTableQuerySafetyLimits } = await import(
      '../../src/data/table-capacity.js'
    );

    tableRowLimitForEnvironment({});
    logTableCapacityDecision({ rowLimit: 25000, mobile: false, deviceMemoryGiB: 4, heapSizeLimitGiB: null, hardwareConcurrency: 8 }, { info: () => {} });
    applyTableQuerySafetyLimits([{ name: 'events', from: 'raw-events', limit: 500000 }], ['events']);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a fallback event under its predictable category when no memory signal is available', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-capacity');
    const { tableRowLimitForEnvironment } = await import('../../src/data/table-capacity.js');

    tableRowLimitForEnvironment({ hardwareConcurrency: 8 });

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:table-capacity]',
      expect.objectContaining({ event: 'memory-signal-unavailable', hardwareConcurrency: 8 })
    );
  });

  it('logs the selected row limit when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-capacity');
    const { logTableCapacityDecision } = await import('../../src/data/table-capacity.js');

    logTableCapacityDecision(
      { rowLimit: 25000, mobile: false, deviceMemoryGiB: 4, heapSizeLimitGiB: null, hardwareConcurrency: 8 },
      { info: () => {} }
    );

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:table-capacity]',
      expect.objectContaining({ event: 'row-limit-selected', rowLimit: 25000, mobile: false, hardwareConcurrency: 8 })
    );
  });

  it('logs a clamp event only when a declared query limit is reduced to the safety ceiling', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-capacity');
    const { applyTableQuerySafetyLimits } = await import('../../src/data/table-capacity.js');

    applyTableQuerySafetyLimits(
      [
        { name: 'events', from: 'raw-events', limit: 500000 },
        { name: 'runs', from: 'runs', limit: 100 }
      ],
      ['events', 'runs']
    );

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:table-capacity]',
      expect.objectContaining({ event: 'query-limit-clamped', query: 'events', appliedLimit: 100000 })
    );
    expect(debugFn).not.toHaveBeenCalledWith(
      '[cao:table-capacity]',
      expect.objectContaining({ query: 'runs' })
    );
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-capacity');
    const { logTableCapacityDecision, applyTableQuerySafetyLimits, tableRowLimitForEnvironment } = await import(
      '../../src/data/table-capacity.js'
    );

    tableRowLimitForEnvironment({ hardwareConcurrency: 8 });
    logTableCapacityDecision(
      { rowLimit: 25000, mobile: false, deviceMemoryGiB: 4, heapSizeLimitGiB: null, hardwareConcurrency: 8 },
      { info: () => {} }
    );
    applyTableQuerySafetyLimits([{ name: 'events', from: 'raw-events', limit: 500000 }], ['events']);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
