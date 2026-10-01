// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSourceStore } from '../../src/source-store.js';

/**
 * Loads renderLinkButtonList with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadLinkButtonListWithDebug(search) {
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
  const module = await import('../../src/components/link-button-list.js');
  return { ...module, output };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function contextWithRows(rows) {
  return {
    sourceNames: ['links'],
    sources: {
      links: {
        source: 'links',
        rows,
        metadata: {
          'source-id': 'links',
          'source-kind': 'query',
          'as-of': '2026-01-01T00:00:00Z',
          'retrieved-at': '2026-01-01T00:00:00Z',
          completeness: 'complete',
          freshness: 'fresh'
        }
      }
    },
    elementConfig: { 'label-field': 'label', 'link-field': 'link' },
    pageId: 'overview',
    viewId: 'quick-links',
    title: 'Quick links',
    contextDetails: [],
    headingTag: 'h3'
  };
}

describe('link-button-list debug logging', () => {
  beforeEach(resetSourceStore);
  afterEach(async () => {
    resetSourceStore();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
    document.body.replaceChildren();
  });

  it('is disabled by default when the debug query is absent', async () => {
    const { renderLinkButtonList, output } = await loadLinkButtonListWithDebug('');

    renderLinkButtonList(contextWithRows([{ label: 'Docs', link: { href: 'https://example.com/docs' } }]));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an initialized event with the bound source name under its predictable category', async () => {
    const { renderLinkButtonList, output } = await loadLinkButtonListWithDebug('?debug=link-button-list');

    renderLinkButtonList(contextWithRows([]));

    expect(output.debug).toHaveBeenCalledWith('[cao:link-button-list]', { event: 'initialized', sourceName: 'links' });
  });

  it('logs an items-updated event with the rendered item count', async () => {
    const { renderLinkButtonList, output } = await loadLinkButtonListWithDebug('?debug=link-button-list');

    renderLinkButtonList(contextWithRows([
      { label: 'Docs', link: { href: 'https://example.com/docs' } },
      { label: 'Status', link: { href: 'https://example.com/status' } }
    ]));

    expect(output.debug).toHaveBeenCalledWith('[cao:link-button-list]', { event: 'items-updated', count: 2 });
  });

  it('logs a pending-changed event only once for an already-settled source', async () => {
    const { renderLinkButtonList, output } = await loadLinkButtonListWithDebug('?debug=link-button-list');

    renderLinkButtonList(contextWithRows([{ label: 'Docs', link: { href: 'https://example.com/docs' } }]));

    const pendingChangedCalls = output.debug.mock.calls.filter(([, payload]) => payload.event === 'pending-changed');
    expect(pendingChangedCalls.length).toBe(1);
    expect(pendingChangedCalls[0][1]).toEqual({ event: 'pending-changed', pending: false });
  });

  it('logs only already-computed scalar metadata, never raw row or source objects', async () => {
    const { renderLinkButtonList, output } = await loadLinkButtonListWithDebug('?debug=link-button-list');

    renderLinkButtonList(contextWithRows([
      { label: 'Docs', link: { href: 'https://example.com/docs' } }
    ]));

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const [, payload] of output.debug.mock.calls) {
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
