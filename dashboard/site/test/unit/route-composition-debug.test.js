// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('route composition debug logging', () => {
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
    const { bindRouteChangeListener } = await import('../../src/components/route-composition.js');

    const root = document.createElement('div');
    document.body.append(root);
    bindRouteChangeListener(root, 'item', () => {});
    root.dispatchEvent(new CustomEvent('dashboard-route-change', { detail: { parameter: 'item', value: 'known' } }));
    root.dispatchEvent(new CustomEvent('dashboard-route-change', { detail: { parameter: 'other', value: 'ignored' } }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the predictable bind, applied, and ignored outcomes under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-composition', output })
      };
    });
    vi.resetModules();
    const { bindRouteChangeListener } = await import('../../src/components/route-composition.js');

    const root = document.createElement('div');
    document.body.append(root);
    const render = vi.fn();
    bindRouteChangeListener(root, 'item', render);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-composition]',
      { event: 'bound', routeParameter: 'item' }
    );

    output.debug.mockClear();
    root.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: '<known-item-with-sensitive-text>' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-composition]',
      { event: 'change-applied', routeParameter: 'item', hasValue: true }
    );

    output.debug.mockClear();
    root.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'other-item', value: 'ignored' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-composition]',
      { event: 'change-ignored', routeParameter: 'item' }
    );

    // Never log the raw, potentially sensitive route value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }
  });
});
