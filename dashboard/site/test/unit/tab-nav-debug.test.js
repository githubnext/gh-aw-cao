// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  document.body.replaceChildren();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importTabNavWithDebug({ search, output }) {
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
  return import('../../src/components/tab-nav.js');
}

/** @param {{ renderInteractiveTabs: typeof import('../../src/components/tab-nav.js').renderInteractiveTabs }} module */
function renderSampleTabs({ renderInteractiveTabs }) {
  const onSelect = vi.fn();
  const rendered = renderInteractiveTabs({
    className: 'campaign-mode-tabs',
    ariaLabel: 'Filter campaign activity by mode',
    panelId: 'campaigns-mode-panel',
    onSelect,
    tabs: [
      { label: 'All', value: 'all', selected: true },
      { label: 'Review', value: 'review' },
      { label: 'Live', value: 'live' }
    ]
  });
  document.body.append(rendered);
  const buttons = /** @type {HTMLButtonElement[]} */ ([...rendered.querySelectorAll('[role="tab"]')]);
  return { rendered, buttons, onSelect };
}

describe('tab-nav debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importTabNavWithDebug({ search: '', output });
    const { buttons } = renderSampleTabs(module);

    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const parent = /** @type {ParentNode} */ (buttons[0].parentElement);
    module.updateInteractiveTabSelection(parent, 'review');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs select, navigate, and sync-selection events under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    const module = await importTabNavWithDebug({ search: '?debug=tab-nav', output });
    const { rendered, buttons } = renderSampleTabs(module);

    buttons[0].click();
    expect(output.debug).toHaveBeenCalledWith('[cao:tab-nav]', { event: 'select', value: 'all', tabCount: 3, via: 'click' });

    output.debug.mockClear();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(output.debug).toHaveBeenCalledWith('[cao:tab-nav]', { event: 'navigate', key: 'ArrowRight', fromIndex: 0, toIndex: 1 });

    output.debug.mockClear();
    module.updateInteractiveTabSelection(rendered, 'review');
    expect(output.debug).toHaveBeenCalledWith('[cao:tab-nav]', { event: 'sync-selection', value: 'review', tabCount: 3, matchedCount: 1 });
  });

  it('is selected by the predictable "tab-nav" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importTabNavWithDebug({ search: '?debug=some-other-category', output });
    const { buttons } = renderSampleTabs(module);

    buttons[0].click();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importTabNavWithDebug({ search: '?debug=tab-nav', output });
    const { rendered, buttons } = renderSampleTabs(module);

    buttons[0].click();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    module.updateInteractiveTabSelection(rendered, 'live');

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
