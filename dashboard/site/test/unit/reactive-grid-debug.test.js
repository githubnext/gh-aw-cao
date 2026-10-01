// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads renderReactiveGrid (and the `state` helper from the same reset
 * `reactive.js` module instance) with a stubbed debug output so assertions
 * can inspect emitted metadata without depending on module state left over
 * from other tests.
 * @param {string} search
 */
async function loadReactiveGridWithDebug(search) {
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
  const module = await import('../../src/components/reactive-grid.js');
  const { state } = await import('../../src/reactive.js');
  return { ...module, state, output };
}

describe('reactive-grid debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderReactiveGrid, output } = await loadReactiveGridWithDebug('');
    const controller = new AbortController();

    renderReactiveGrid({
      items: () => [1, 2],
      key: (item) => String(item),
      renderItem: (item) => h('li', null, String(item)),
      signal: controller.signal
    });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a composed event with the grid className under its predictable category', async () => {
    const { renderReactiveGrid, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();

    renderReactiveGrid({
      className: 'factory-floor',
      items: () => [1, 2],
      key: (item) => String(item),
      renderItem: (item) => h('li', null, String(item)),
      signal: controller.signal
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', {
      event: 'composed',
      className: 'factory-floor'
    });
  });

  it('logs an items-updated event only when the rendered item count changes', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const count = state(2);

    renderReactiveGrid({
      items: () => Array.from({ length: count.get() }, (_, index) => index),
      key: (item) => String(item),
      renderItem: (item) => h('li', null, String(item)),
      signal: controller.signal
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', { event: 'items-updated', count: 2 });
    output.debug.mockClear();

    count.set(2);
    expect(output.debug).not.toHaveBeenCalled();

    count.set(5);
    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', { event: 'items-updated', count: 5 });
  });

  it('logs an active-changed event only when the active state transitions', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const active = state(false);

    renderReactiveGrid({
      activeClassName: 'is-active',
      items: () => [],
      key: (item) => String(item),
      renderItem: (item) => h('li', null, String(item)),
      active: () => active.get(),
      signal: controller.signal
    });
    output.debug.mockClear();

    active.set(true);
    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', { event: 'active-changed', active: true });
    output.debug.mockClear();

    active.set(true);
    expect(output.debug).not.toHaveBeenCalled();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});
