// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads ui-elements.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadUiElementsWithDebug(search) {
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
  const module = await import('../../src/components/ui-elements.js');
  return { ...module, output };
}

describe('ui-elements debug logging', () => {
  afterEach(async () => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default when the debug query is absent', async () => {
    const { renderUiElement, output } = await loadUiElementsWithDebug('');

    renderUiElement('no-such-element', /** @type {never} */ ({}));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an unregistered-element event under its predictable category', async () => {
    const { renderUiElement, output } = await loadUiElementsWithDebug('?debug=ui-elements');

    const result = renderUiElement('no-such-element', /** @type {never} */ ({}));

    expect(result).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:ui-elements]', {
      event: 'unregistered-element',
      name: 'no-such-element'
    });
    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('does not log when a registered element renders synchronously', async () => {
    const { renderUiElement, output } = await loadUiElementsWithDebug('?debug=ui-elements');

    renderUiElement('markdown', /** @type {never} */ ({
      elementConfig: { 'content-field': 'body' },
      sourceNames: ['notes'],
      sources: {}
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs lazy-render start and completion metadata for lazily-loaded elements', async () => {
    const { renderUiElementAsync, output } = await loadUiElementsWithDebug('?debug=ui-elements');

    await renderUiElementAsync('campaign-route', /** @type {never} */ ({
      sourceNames: [],
      sources: {},
      contextDetails: []
    }));

    expect(output.debug).toHaveBeenCalledWith('[cao:ui-elements]', {
      event: 'lazy-render-started',
      name: 'campaign-route'
    });
    const completed = output.debug.mock.calls.find((call) => call[1]?.event === 'lazy-render-completed');
    expect(completed).toBeTruthy();
    const metadata = /** @type {NonNullable<typeof completed>} */ (completed)[1];
    expect(metadata.name).toBe('campaign-route');
    expect(typeof metadata.durationMs).toBe('number');
    expect(typeof metadata.rendered).toBe('boolean');
    for (const call of output.debug.mock.calls) {
      expect(Object.values(call[1]).every((value) => typeof value !== 'object')).toBe(true);
    }
  });
});
