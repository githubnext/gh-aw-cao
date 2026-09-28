// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('route empty state debug logging', () => {
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
    const { createRouteView } = await import('../../src/components/route-empty-state.js');

    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      renderMatched: () => null
    });
    document.body.append(view);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the predictable outcome under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-empty-state', output })
      };
    });
    vi.resetModules();
    const { createRouteView } = await import('../../src/components/route-empty-state.js');

    const matched = document.createElement('section');
    const renderMatched = vi.fn((routeValue) => routeValue === 'known' ? matched : null);
    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      renderMatched
    });
    document.body.append(view);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-empty-state]',
      { parameter: 'item', outcome: 'select', hasSelection: false }
    );

    output.debug.mockClear();
    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: '<missing-item-with-sensitive-text>' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-empty-state]',
      { parameter: 'item', outcome: 'not-found', hasSelection: true }
    );

    output.debug.mockClear();
    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: 'known' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-empty-state]',
      { parameter: 'item', outcome: 'matched', hasSelection: true }
    );

    // Never log the raw, potentially sensitive route value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }
  });

  it('logs the unavailable outcome ahead of route matching', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-empty-state', output })
      };
    });
    vi.resetModules();
    const { createRouteView } = await import('../../src/components/route-empty-state.js');

    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      unavailableMessage: 'Item data is unavailable.',
      isUnavailable: () => true,
      renderMatched: () => document.createElement('div')
    });
    document.body.append(view);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-empty-state]',
      { parameter: 'item', outcome: 'unavailable', hasSelection: false }
    );
  });
});
