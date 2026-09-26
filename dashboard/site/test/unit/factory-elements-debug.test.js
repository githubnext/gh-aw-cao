// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSourceLoader, resetSourceStore } from '../../src/source-store.js';

/**
 * Loads bindFactorySources/createFactoryScope with a stubbed debug output so
 * assertions can inspect emitted metadata without depending on module state
 * left over from other tests.
 * @param {string} search
 */
async function loadFactoryElementsWithDebug(search) {
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
  const module = await import('../../src/components/factory-elements.js');
  return { ...module, output };
}

describe('factory-elements debug logging', () => {
  beforeEach(resetSourceStore);
  afterEach(async () => {
    resetSourceStore();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default when the debug query is absent', async () => {
    const { bindFactorySources, output } = await loadFactoryElementsWithDebug('');
    configureSourceLoader(() => new Promise(() => {}));

    bindFactorySources({}, ['overview-header-presentation'], { pageId: 'overview', viewId: 'overview-header' });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar binding metadata under its predictable category', async () => {
    const { bindFactorySources, output } = await loadFactoryElementsWithDebug('?debug=factory-elements');
    configureSourceLoader(() => new Promise(() => {}));

    bindFactorySources({}, ['overview-header-presentation', 'overview-rhythm'], {
      pageId: 'overview',
      viewId: 'overview-header'
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-elements]', {
      event: 'bound',
      pageId: 'overview',
      viewId: 'overview-header',
      sourceCount: 2,
      requestedCount: 2,
      refresh: false
    });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('logs a scope-aborted event once the element disconnects', async () => {
    const { createFactoryScope, output } = await loadFactoryElementsWithDebug('?debug=factory-elements');

    const scope = createFactoryScope();
    const element = document.createElement('div');
    document.body.append(element);
    scope.bind(element);
    element.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-elements]', { event: 'scope-aborted' });
    document.body.replaceChildren();
  });
});
