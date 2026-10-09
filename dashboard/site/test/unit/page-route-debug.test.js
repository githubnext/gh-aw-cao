// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
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

describe('page-route debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('');

    const root = document.createElement('section');
    root.innerHTML = '<div data-route-view></div>';
    document.body.append(root);

    dispatchPageRoute(root, 'item', 'known');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the matched route-view count under its predictable category when enabled', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');

    const root = document.createElement('section');
    root.innerHTML = '<div data-route-view></div><div data-route-view></div>';
    document.body.append(root);

    dispatchPageRoute(root, 'item', 'known');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:page-route]',
      { operation: 'dispatch-page-route', parameter: 'item', matchedCount: 2 }
    );
  });

  it('includes the root element itself when it is a route view', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');

    const root = document.createElement('section');
    root.setAttribute('data-route-view', '');
    document.body.append(root);

    dispatchPageRoute(root, 'item', 'known');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:page-route]',
      { operation: 'dispatch-page-route', parameter: 'item', matchedCount: 1 }
    );
  });

  it('logs zero matches without throwing when no route views exist', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');

    const root = document.createElement('section');
    document.body.append(root);

    dispatchPageRoute(root, 'item', 'known');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:page-route]',
      { operation: 'dispatch-page-route', parameter: 'item', matchedCount: 0 }
    );
  });

  it('never logs the raw route value, only scalar metadata', async () => {
    const { dispatchPageRoute, output } = await loadPageRouteWithDebug('?debug=page-route');

    const root = document.createElement('section');
    root.innerHTML = '<div data-route-view></div>';
    document.body.append(root);

    dispatchPageRoute(root, 'item', '<sensitive-route-value>');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-route-value');
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
