import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('retry debug logging', () => {
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
    const { withRetries } = await import('../../src/retry.js');

    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('refreshed');
    await expect(withRetries(operation, { delayMs: 0 })).resolves.toBe('refreshed');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs retrying, succeeded, and exhausted events under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=retry', output })
      };
    });
    vi.resetModules();
    const { withRetries } = await import('../../src/retry.js');

    const recovering = vi.fn()
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockResolvedValue('refreshed');
    await expect(withRetries(recovering, { delayMs: 0 })).resolves.toBe('refreshed');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:retry]',
      { event: 'retrying', attempt: 1, attempts: 3, backoffMs: 0, errorName: 'TypeError' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:retry]',
      { event: 'succeeded', attempt: 2, attempts: 3 }
    );

    output.debug.mockClear();
    const failing = vi.fn().mockRejectedValue(new Error('still unavailable'));
    await expect(withRetries(failing, { attempts: 2, delayMs: 0 })).rejects.toThrow('still unavailable');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:retry]',
      { event: 'retrying', attempt: 1, attempts: 2, backoffMs: 0, errorName: 'Error' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:retry]',
      { event: 'exhausted', attempt: 2, attempts: 2, errorName: 'Error' }
    );
  });

  it('never logs sensitive payload content, only scalar retry metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=retry', output })
      };
    });
    vi.resetModules();
    const { withRetries } = await import('../../src/retry.js');

    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('secret token abc123 leaked in message'))
      .mockResolvedValue('refreshed');
    await expect(withRetries(operation, { delayMs: 0 })).resolves.toBe('refreshed');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret token');
      expect(JSON.stringify(payload)).not.toContain('abc123');
    }
  });
});
