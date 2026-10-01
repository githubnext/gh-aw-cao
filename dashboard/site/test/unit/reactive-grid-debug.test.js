// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads renderReactiveGrid (and the matching `state` factory) with a stubbed
 * debug output so assertions can inspect emitted metadata. `state` is
 * re-imported from the same reset module graph as `reactive-grid.js` so its
 * reactive bookkeeping is shared with the effect the grid registers.
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

/**
 * @param {typeof import('../../src/components/reactive-grid.js').renderReactiveGrid} renderReactiveGrid
 * @param {{ get: () => { active: boolean, label: string, items: Array<{ id: string }> } }} gridState
 * @param {AbortSignal} signal
 */
function buildGrid(renderReactiveGrid, gridState, signal) {
  return renderReactiveGrid({
    className: 'example-grid',
    activeClassName: 'example-grid-active',
    items: () => gridState.get().items,
    key: (/** @type {{ id: string }} */ item) => item.id,
    renderItem: (/** @type {{ id: string }} */ item) => h('li', { dataset: { id: item.id } }, item.id),
    active: () => gridState.get().active,
    ariaLabel: () => gridState.get().label,
    signal
  });
}

describe('reactive-grid debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('');
    const controller = new AbortController();
    const gridState = state({ active: false, label: 'Items', items: [{ id: 'one' }] });

    buildGrid(renderReactiveGrid, gridState, controller.signal);

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs an initialized event under its predictable category', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const gridState = state({ active: false, label: 'Items', items: [] });

    buildGrid(renderReactiveGrid, gridState, controller.signal);

    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', {
      event: 'initialized',
      hasActiveClassName: true
    });
    controller.abort();
  });

  it('logs an items-updated event with the rendered item count', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const gridState = state({ active: false, label: 'Items', items: [{ id: 'one' }, { id: 'two' }] });

    buildGrid(renderReactiveGrid, gridState, controller.signal);

    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', { event: 'items-updated', count: 2 });
    controller.abort();
  });

  it('logs an active-changed event only when the active flag transitions', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const gridState = state({ active: false, label: 'Items', items: [{ id: 'one' }] });

    buildGrid(renderReactiveGrid, gridState, controller.signal);
    output.debug.mockClear();

    gridState.set({ active: false, label: 'Items', items: [{ id: 'one' }, { id: 'two' }] });
    expect(output.debug).not.toHaveBeenCalledWith('[cao:reactive-grid]', expect.objectContaining({ event: 'active-changed' }));

    gridState.set({ active: true, label: 'Items', items: [{ id: 'one' }, { id: 'two' }] });
    expect(output.debug).toHaveBeenCalledWith('[cao:reactive-grid]', { event: 'active-changed', active: true });

    controller.abort();
  });

  it('logs only already-computed scalar metadata, never raw item or state objects', async () => {
    const { renderReactiveGrid, state, output } = await loadReactiveGridWithDebug('?debug=reactive-grid');
    const controller = new AbortController();
    const gridState = state({ active: true, label: 'Items', items: [{ id: 'one' }] });

    buildGrid(renderReactiveGrid, gridState, controller.signal);

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const [, payload] of output.debug.mock.calls) {
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
    controller.abort();
  });
});
