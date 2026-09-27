// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('lazy view debug logging', () => {
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
    const { enableLazyViews, renderLazyView } = await import('../../src/components/lazy-view.js');

    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Findings', render });
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs started and completed hydration status under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=lazy-view', output })
      };
    });
    vi.resetModules();
    const { enableLazyViews, renderLazyView } = await import('../../src/components/lazy-view.js');

    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Findings', render });
    lazyView.setAttribute('data-view-id', 'findings');
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:lazy-view]',
      { viewId: 'findings', status: 'started' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:lazy-view]',
      expect.objectContaining({ viewId: 'findings', status: 'completed', durationMs: expect.any(Number) })
    );
  });

  it('logs a failed hydration with a sanitized error name only', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=lazy-view', output })
      };
    });
    vi.resetModules();
    const { enableLazyViews, renderLazyView } = await import('../../src/components/lazy-view.js');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const render = vi.fn(() => {
      throw new TypeError('renderer failed with sensitive payload details');
    });
    const lazyView = renderLazyView({ label: 'Broken', render });
    lazyView.setAttribute('data-view-id', 'broken');
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:lazy-view]',
      { viewId: 'broken', status: 'failed', errorName: 'TypeError' }
    );
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('sensitive payload details');
    }
    consoleError.mockRestore();
  });
});
