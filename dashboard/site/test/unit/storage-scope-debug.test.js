// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('storage-scope debug logging', () => {
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
    const { clearScopedStorage, dashboardPagePath } = await import('../../src/storage-scope.js');

    dashboardPagePath('https://example.github.io/control-a/src/main.js', '/control-a/index.html');
    clearScopedStorage(localStorage, '/control-a/');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs page-path resolution source and cleared-key count under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=storage-scope', output })
      };
    });
    vi.resetModules();
    const { clearScopedStorage, dashboardPagePath, scopedStorageKey } = await import('../../src/storage-scope.js');

    dashboardPagePath('https://example.github.io/control-a/src/main.js', '/control-a/index.html');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:storage-scope]',
      { event: 'page-path-resolved', source: 'module-url' }
    );

    output.debug.mockClear();
    dashboardPagePath('file:///workspace/src/storage-scope.js', '/preview/');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:storage-scope]',
      { event: 'page-path-resolved', source: 'document' }
    );

    output.debug.mockClear();
    dashboardPagePath('blob:https://example.com/id', '');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:storage-scope]',
      { event: 'page-path-resolved', source: 'default-root' }
    );

    output.debug.mockClear();
    const baseKey = 'central-agentic-ops.dashboard.theme';
    localStorage.setItem(scopedStorageKey(baseKey, '/control-a/'), 'dark');
    localStorage.setItem(scopedStorageKey(baseKey, '/control-b/'), 'light');
    localStorage.setItem('unrelated-setting', 'value');

    clearScopedStorage(localStorage, '/control-a/');

    const clearedCalls = output.debug.mock.calls.filter(([, payload]) => payload.event === 'scoped-storage-cleared');
    expect(clearedCalls).toHaveLength(1);
    expect(clearedCalls[0][1]).toEqual({ event: 'scoped-storage-cleared', removedCount: 1 });
  });

  it('never logs storage keys or values, only scalar scope metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=storage-scope', output })
      };
    });
    vi.resetModules();
    const { clearScopedStorage, scopedStorageKey } = await import('../../src/storage-scope.js');

    const baseKey = 'central-agentic-ops.dashboard.theme';
    localStorage.setItem(scopedStorageKey(baseKey, '/control-a/'), 'super-secret-value');

    clearScopedStorage(localStorage, '/control-a/');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('super-secret-value');
      expect(JSON.stringify(payload)).not.toContain('theme');
    }
  });
});
