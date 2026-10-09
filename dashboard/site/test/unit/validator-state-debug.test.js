import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-state debug logging', () => {
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
    const { state, resolveReusablePageViews } = await import('../../src/validator-state.js');

    state.declaredViews.set('run-count', { id: 'run-count' });
    resolveReusablePageViews({ kind: 'custom', views: ['run-count', 'missing-view'] });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs page kind, view count, and unresolved count under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-state', output })
      };
    });
    vi.resetModules();
    const { state, resolveReusablePageViews } = await import('../../src/validator-state.js');

    state.declaredViews.set('run-count', { id: 'run-count' });
    resolveReusablePageViews({ kind: 'custom', views: ['run-count', 'missing-view'] });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-state]',
      { operation: 'resolve-reusable-page-views', pageKind: 'custom', viewCount: 2, unresolvedCount: 1 }
    );

    output.debug.mockClear();
    resolveReusablePageViews({ kind: 'built-in', definition: { views: ['run-count'] } });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-state]',
      { operation: 'resolve-reusable-page-views', pageKind: 'built-in', viewCount: 1, unresolvedCount: 0 }
    );
  });

  it('does not log when the page has no resolvable views array', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-state', output })
      };
    });
    vi.resetModules();
    const { resolveReusablePageViews } = await import('../../src/validator-state.js');

    resolveReusablePageViews('not-a-page');
    resolveReusablePageViews({ kind: 'custom' });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs view identifiers or page content, only scalar page kind and counts', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-state', output })
      };
    });
    vi.resetModules();
    const { state, resolveReusablePageViews } = await import('../../src/validator-state.js');

    state.declaredViews.set('secret-view-name', { id: 'secret-view-name' });
    resolveReusablePageViews({ kind: 'custom', views: ['secret-view-name', 'another-missing-view'] });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-view-name');
      expect(JSON.stringify(payload)).not.toContain('another-missing-view');
    }
  });
});
