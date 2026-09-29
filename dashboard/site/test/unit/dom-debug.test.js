// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.head.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('dom.js debug logging', () => {
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
    const { injectStyleOnce } = await import('../../src/dom.js');

    injectStyleOnce(document, 'widget-styles', '.widget { color: red; }');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an inserted outcome under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=dom', output })
      };
    });
    vi.resetModules();
    const { injectStyleOnce } = await import('../../src/dom.js');

    injectStyleOnce(document, 'widget-styles', '.widget { color: red; }');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom]',
      { event: 'inject-style-once', marker: 'widget-styles', outcome: 'inserted', length: '.widget { color: red; }'.length }
    );
  });

  it('logs a skipped-duplicate outcome for a repeated marker', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=dom', output })
      };
    });
    vi.resetModules();
    const { injectStyleOnce } = await import('../../src/dom.js');

    injectStyleOnce(document, 'widget-styles', '.widget { color: red; }');
    output.debug.mockClear();
    injectStyleOnce(document, 'widget-styles', '.widget { color: blue; }');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom]',
      { event: 'inject-style-once', marker: 'widget-styles', outcome: 'skipped-duplicate' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=dom', output })
      };
    });
    vi.resetModules();
    const { injectStyleOnce } = await import('../../src/dom.js');

    injectStyleOnce(document, 'widget-styles', '.widget { color: red; background: url(https://example.com/secret); }');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/color|background|url|secret/);
    }
  });
});
