// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads renderReactiveGraphWidget (and the matching `state` factory) with a
 * stubbed debug output so assertions can inspect emitted metadata. `state`
 * is re-imported from the same reset module graph as `graph-widget.js` so
 * its reactive bookkeeping is shared with the effect the widget registers.
 * @param {string} search
 */
async function loadGraphWidgetWithDebug(search) {
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
  const module = await import('../../src/components/graph-widget.js');
  const { state } = await import('../../src/reactive.js');
  return { ...module, state, output };
}

/**
 * @param {typeof import('../../src/components/graph-widget.js').renderReactiveGraphWidget} renderReactiveGraphWidget
 * @param {{ get: () => Array<{ id: string }> }} itemsState
 * @param {AbortSignal} signal
 */
function buildWidget(renderReactiveGraphWidget, itemsState, signal) {
  return renderReactiveGraphWidget({
    title: 'Example',
    ariaLabel: 'Example graph',
    legendLabel: 'Legend',
    legend: [{ label: 'Series', className: 'series' }],
    items: () => itemsState.get(),
    key: (/** @type {{ id: string }} */ item) => item.id,
    renderItem: (/** @type {{ id: string }} */ item) => h('div', { dataset: { id: item.id } }, item.id),
    updateItem: () => {},
    signal
  });
}

describe('graph-widget debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderReactiveGraphWidget, state, output } = await loadGraphWidgetWithDebug('');
    const controller = new AbortController();
    const itemsState = state([{ id: 'one' }]);

    buildWidget(renderReactiveGraphWidget, itemsState, controller.signal);

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs an initialized event under its predictable category', async () => {
    const { renderReactiveGraphWidget, state, output } = await loadGraphWidgetWithDebug('?debug=graph-widget');
    const controller = new AbortController();
    const itemsState = state([]);

    buildWidget(renderReactiveGraphWidget, itemsState, controller.signal);

    expect(output.debug).toHaveBeenCalledWith('[cao:graph-widget]', {
      event: 'initialized',
      hasYAxisLabel: false,
      legendCount: 1
    });
    controller.abort();
  });

  it('logs an items-updated event with the rendered item count', async () => {
    const { renderReactiveGraphWidget, state, output } = await loadGraphWidgetWithDebug('?debug=graph-widget');
    const controller = new AbortController();
    const itemsState = state([{ id: 'one' }, { id: 'two' }]);

    buildWidget(renderReactiveGraphWidget, itemsState, controller.signal);

    expect(output.debug).toHaveBeenCalledWith('[cao:graph-widget]', { event: 'items-updated', count: 2 });
    controller.abort();
  });

  it('logs a stale-elements-pruned event only when keyed items are removed', async () => {
    const { renderReactiveGraphWidget, state, output } = await loadGraphWidgetWithDebug('?debug=graph-widget');
    const controller = new AbortController();
    const itemsState = state([{ id: 'one' }, { id: 'two' }]);

    buildWidget(renderReactiveGraphWidget, itemsState, controller.signal);
    output.debug.mockClear();

    itemsState.set([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
    expect(output.debug).not.toHaveBeenCalledWith('[cao:graph-widget]', expect.objectContaining({ event: 'stale-elements-pruned' }));

    itemsState.set([{ id: 'one' }]);
    expect(output.debug).toHaveBeenCalledWith('[cao:graph-widget]', { event: 'stale-elements-pruned', count: 2 });

    controller.abort();
  });

  it('logs only already-computed scalar metadata, never raw item or state objects', async () => {
    const { renderReactiveGraphWidget, state, output } = await loadGraphWidgetWithDebug('?debug=graph-widget');
    const controller = new AbortController();
    const itemsState = state([{ id: 'one' }]);

    buildWidget(renderReactiveGraphWidget, itemsState, controller.signal);

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const [, payload] of output.debug.mock.calls) {
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
    controller.abort();
  });
});
