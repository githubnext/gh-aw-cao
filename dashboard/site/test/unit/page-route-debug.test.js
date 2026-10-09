// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads page-route.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadPageRouteWithDebug(search) {
  const output = { debug: vi.fn() };
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
  const module = await import('../../src/components/page-route.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('page-route debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('');
    const root = document.createElement('div');
    root.setAttribute('data-route-view', '');

    dispatchPageRoute(root, 'tab', 'runs');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the dispatched parameter and matched route-view count under its predictable category when enabled', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');
    const root = document.createElement('div');
    root.setAttribute('data-route-view', '');
    const child = document.createElement('div');
    child.setAttribute('data-route-view', '');
    root.append(child);

    dispatchPageRoute(root, 'tab', 'runs');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:page-route]',
      { operation: 'dispatch-page-route', parameter: 'tab', matched: 2 }
    );
  });

  it('still dispatches the route-change event to matched views when logging is enabled', async () => {
    const { dispatchPageRoute } = await loadPageRouteWithDebug('?debug=page-route');
    const root = document.createElement('div');
    root.setAttribute('data-route-view', '');
    const listener = vi.fn();
    root.addEventListener('dashboard-route-change', listener);

    dispatchPageRoute(root, 'tab', 'runs');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({ parameter: 'tab', value: 'runs' });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');
    const root = document.createElement('div');
    root.setAttribute('data-route-view', '');

    dispatchPageRoute(root, 'tab', 'runs');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
