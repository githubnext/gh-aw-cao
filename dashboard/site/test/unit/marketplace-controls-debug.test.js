// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads marketplace-controls.js with a stubbed debug output so assertions
 * can inspect emitted metadata without depending on module state left over
 * from other tests.
 * @param {string} search
 */
async function loadMarketplaceControlsWithDebug(search) {
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
  const module = await import('../../src/components/marketplace-controls.js');
  return { ...module, output };
}

/** @param {Array<[string, string]>} rows */
function rowsSource(rows) {
  return { rows: rows.map(([key, value]) => ({ 'registry-id': key, 'registry-name': value, publisher: value })) };
}

/** @returns {import('../../src/components/ui-elements.js').ElementRenderContext} */
function baseContext() {
  return /** @type {any} */ ({
    pageId: 'agent-marketplace',
    sourceNames: ['registries', 'publishers'],
    sources: {
      registries: rowsSource([['npm', 'npm']]),
      publishers: rowsSource([['acme', 'acme']])
    },
    queryContext: {}
  });
}

describe('marketplace-controls debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderMarketplaceControls, output } = await loadMarketplaceControlsWithDebug('');
    renderMarketplaceControls(baseContext());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a predictable rendered event under its category', async () => {
    const { renderMarketplaceControls, output } = await loadMarketplaceControlsWithDebug('?debug=marketplace-controls');
    renderMarketplaceControls(baseContext());

    expect(output.debug).toHaveBeenCalledWith('[cao:marketplace-controls]', {
      event: 'rendered',
      registryOptionCount: 1,
      publisherOptionCount: 1,
      initialSort: 'relevance'
    });
  });

  it('logs a query-context-changed event with the interaction trigger, not raw query text', async () => {
    const { renderMarketplaceControls, output } = await loadMarketplaceControlsWithDebug('?debug=marketplace-controls');
    const root = renderMarketplaceControls(baseContext());
    document.body.append(root);

    const search = /** @type {HTMLInputElement} */ (root.querySelector('[name="package-search"]'));
    search.value = 'octo tools';
    root.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(output.debug).toHaveBeenCalledWith('[cao:marketplace-controls]', {
      event: 'query-context-changed',
      trigger: 'submit',
      filterCount: 0,
      hasSearch: true,
      sort: 'relevance'
    });
    document.body.replaceChildren();
  });

  it('logs a change trigger for filter/sort interactions, distinct from search submission', async () => {
    const { renderMarketplaceControls, output } = await loadMarketplaceControlsWithDebug('?debug=marketplace-controls');
    const root = renderMarketplaceControls(baseContext());
    document.body.append(root);

    const sort = /** @type {HTMLSelectElement} */ (root.querySelector('[name="sort"]'));
    sort.value = 'name';
    sort.dispatchEvent(new Event('change', { bubbles: true }));

    expect(output.debug).toHaveBeenCalledWith('[cao:marketplace-controls]', {
      event: 'query-context-changed',
      trigger: 'change',
      filterCount: 0,
      hasSearch: false,
      sort: 'name'
    });
    document.body.replaceChildren();
  });

  it('never logs secrets, raw records, or unconstrained search text, only scalar metadata', async () => {
    const { renderMarketplaceControls, output } = await loadMarketplaceControlsWithDebug('?debug=marketplace-controls');
    const root = renderMarketplaceControls(baseContext());
    document.body.append(root);

    const search = /** @type {HTMLInputElement} */ (root.querySelector('[name="package-search"]'));
    search.value = 'sensitive query text';
    root.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('sensitive query text');
    }
    document.body.replaceChildren();
  });
});
