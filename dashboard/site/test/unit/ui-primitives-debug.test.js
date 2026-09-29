// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('ui-primitives debug logging', () => {
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
    const { copyTextToClipboard } = await import('../../src/components/ui-primitives.js');

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(true);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a succeeded copy-to-clipboard event with scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ui-primitives', output })
      };
    });
    vi.resetModules();
    const { copyTextToClipboard } = await import('../../src/components/ui-primitives.js');

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(true);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:ui-primitives]',
      { operation: 'copy-to-clipboard', outcome: 'succeeded', length: 'hello world'.length }
    );
  });

  it('logs a failed copy-to-clipboard event with a sanitized error name when the write rejects', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ui-primitives', output })
      };
    });
    vi.resetModules();
    const { copyTextToClipboard } = await import('../../src/components/ui-primitives.js');

    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('secret token=abc123')).resolves.toBe(false);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:ui-primitives]',
      { operation: 'copy-to-clipboard', outcome: 'failed', errorName: 'NotAllowedError' }
    );
  });

  it('logs an unavailable copy-to-clipboard event when the Clipboard API is missing', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ui-primitives', output })
      };
    });
    vi.resetModules();
    const { copyTextToClipboard } = await import('../../src/components/ui-primitives.js');

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(false);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:ui-primitives]',
      { operation: 'copy-to-clipboard', outcome: 'unavailable' }
    );
  });

  it('never logs sensitive copied content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ui-primitives', output })
      };
    });
    vi.resetModules();
    const { copyTextToClipboard } = await import('../../src/components/ui-primitives.js');

    const writeText = vi.fn().mockRejectedValue(new Error('do not log this raw message'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('do not log this secret content either')).resolves.toBe(false);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('do not log this raw message');
      expect(JSON.stringify(payload)).not.toContain('do not log this secret content either');
    }
  });
});
