import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  vi.useRealTimers();
});

describe('debounce/throttle debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    vi.useFakeTimers();
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
    const { debounce, throttle } = await import('../../src/debounce.js');

    const debounced = debounce(vi.fn(), 100);
    debounced('a');
    vi.advanceTimersByTime(100);
    debounced.cancel();

    const throttled = throttle(vi.fn(), 100);
    throttled('b');
    vi.advanceTimersByTime(100);
    throttled.cancel();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs fired and cancelled events under its predictable category when enabled', async () => {
    vi.useFakeTimers();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=debounce', output })
      };
    });
    vi.resetModules();
    const { debounce, throttle } = await import('../../src/debounce.js');

    const debounced = debounce(vi.fn(), 100);
    debounced('a');
    vi.advanceTimersByTime(100);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:debounce]',
      { event: 'fired', mode: 'debounce', delayMs: 100 }
    );

    output.debug.mockClear();
    const pendingDebounced = debounce(vi.fn(), 100);
    pendingDebounced('b');
    pendingDebounced.cancel();
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:debounce]',
      { event: 'cancelled', mode: 'debounce' }
    );

    output.debug.mockClear();
    const throttled = throttle(vi.fn(), 100);
    throttled('c');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:debounce]',
      { event: 'fired', mode: 'throttle', delayMs: 100 }
    );

    output.debug.mockClear();
    const pendingThrottled = throttle(vi.fn(), 100);
    pendingThrottled('d');
    pendingThrottled('e');
    pendingThrottled.cancel();
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:debounce]',
      { event: 'cancelled', mode: 'throttle' }
    );
  });

  it('does not log a cancelled event when there is no pending invocation', async () => {
    vi.useFakeTimers();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=debounce', output })
      };
    });
    vi.resetModules();
    const { debounce, throttle } = await import('../../src/debounce.js');

    debounce(vi.fn(), 100).cancel();
    throttle(vi.fn(), 100).cancel();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs callback arguments, only scalar mode and timing metadata', async () => {
    vi.useFakeTimers();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=debounce', output })
      };
    });
    vi.resetModules();
    const { debounce } = await import('../../src/debounce.js');

    const debounced = debounce(vi.fn(), 50);
    debounced('secret-token-abc123', { user: 'sensitive-value' });
    vi.advanceTimersByTime(50);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-token');
      expect(JSON.stringify(payload)).not.toContain('sensitive-value');
    }
  });
});
