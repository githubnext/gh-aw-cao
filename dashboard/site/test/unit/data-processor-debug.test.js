import { afterEach, describe, expect, it, vi } from 'vitest';

class DebugTestWorker {
  /** @type {DebugTestWorker | undefined} */
  static current;

  constructor() {
    DebugTestWorker.current = this;
    /** @type {Map<string, (event: { data: Record<string, unknown>, message?: string }) => void>} */
    this.listeners = new Map();
    this.terminated = false;
  }

  /** @param {string} type @param {(event: { data: Record<string, unknown>, message?: string }) => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage() {}

  /** @param {string} message */
  emitError(message) {
    this.listeners.get('error')?.({ data: {}, message });
  }

  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('dashboard data processor debug logging', () => {
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
    vi.stubGlobal('Worker', DebugTestWorker);
    vi.resetModules();
    const { cancelDataProcessing, processDashboardQueries } = await import('../../src/data-processor.js');

    const pending = processDashboardQueries([], {}).catch(() => {});
    cancelDataProcessing();
    DebugTestWorker.current?.emitError('boom');
    await pending;

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs worker creation and cancellation metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=data-processor', output })
      };
    });
    vi.stubGlobal('Worker', DebugTestWorker);
    vi.useFakeTimers();
    vi.resetModules();
    const { cancelDataProcessing, processDashboardQueries } = await import('../../src/data-processor.js');

    const pending = processDashboardQueries([], {});
    const pendingRejection = expect(pending).rejects.toMatchObject({ name: 'DataProcessingCancelledError' });
    expect(output.debug).toHaveBeenCalledWith('[cao:data-processor]', { event: 'worker-created' });

    const cancelledCount = cancelDataProcessing();
    expect(cancelledCount).toBe(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:data-processor]', { event: 'cancel-requested', cancelledCount: 1 });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    await vi.advanceTimersByTimeAsync(251);
    await pendingRejection;
  });

  it('logs worker-failed metadata with the pending request count and no error detail', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=data-processor', output })
      };
    });
    vi.stubGlobal('Worker', DebugTestWorker);
    vi.resetModules();
    const { processDashboardQueries } = await import('../../src/data-processor.js');

    const pending = processDashboardQueries([], {}).catch(() => {});
    output.debug.mockClear();

    DebugTestWorker.current?.emitError('Worker crashed');
    expect(output.debug).toHaveBeenCalledWith('[cao:data-processor]', { event: 'worker-failed', pendingCount: 1 });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    await pending;
  });
});
