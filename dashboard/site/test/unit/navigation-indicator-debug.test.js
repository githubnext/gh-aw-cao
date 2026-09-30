import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads navigation-indicator.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadNavigationIndicatorWithDebug(search) {
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
  const module = await import('../../src/navigation-indicator.js');
  return { ...module, output };
}

describe('navigation indicator debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { navigationIndicator, navigationIndicatorSourceNames, output } =
      await loadNavigationIndicatorWithDebug('');

    navigationIndicator({ id: 'overview', 'navigation-indicator': { label: 'Attention', any: ['attention-count'] } });
    navigationIndicator({ id: 'settings' });
    navigationIndicatorSourceNames([{ id: 'overview', 'navigation-indicator': { label: 'Attention', any: ['attention-count'] } }]);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a rejected event with the reason under the predictable category name derived from the filename', async () => {
    const { navigationIndicator, output } = await loadNavigationIndicatorWithDebug('?debug=navigation-indicator');

    expect(navigationIndicator({ id: 'settings', 'navigation-indicator': { any: ['attention-count'] } })).toBe(null);
    expect(output.debug).toHaveBeenCalledWith('[cao:navigation-indicator]', {
      event: 'rejected',
      reason: 'missing-label',
      pageId: 'settings'
    });

    expect(navigationIndicator({ id: 'empty', 'navigation-indicator': { label: 'Attention', any: [] } })).toBe(null);
    expect(output.debug).toHaveBeenCalledWith('[cao:navigation-indicator]', {
      event: 'rejected',
      reason: 'no-sources',
      pageId: 'empty'
    });
  });

  it('logs a source-names-resolved event with bounded scalar counts', async () => {
    const { navigationIndicatorSourceNames, output } = await loadNavigationIndicatorWithDebug('?debug=navigation-indicator');

    const pages = [
      { id: 'overview', 'navigation-indicator': { label: 'Attention', any: ['attention-count', 'attention-count'] } },
      { id: 'other', 'navigation-indicator': { label: 'New', any: ['other-count'] } }
    ];
    const sources = navigationIndicatorSourceNames(pages);

    expect(sources).toEqual(['attention-count', 'other-count']);
    expect(output.debug).toHaveBeenCalledWith('[cao:navigation-indicator]', {
      event: 'source-names-resolved',
      pageCount: 2,
      rawCount: 3,
      uniqueCount: 2
    });
  });

  it('never logs raw source names or labels, only scalar metadata', async () => {
    const { navigationIndicator, navigationIndicatorSourceNames, output } = await loadNavigationIndicatorWithDebug('?debug=navigation-indicator');

    navigationIndicator({ id: 'secret-page', 'navigation-indicator': { label: 'do-not-log-this-secret-label', any: [] } });
    navigationIndicatorSourceNames([{ id: 'secret-page', 'navigation-indicator': { label: 'x', any: ['do-not-log-this-secret-source'] } }]);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('do-not-log-this-secret');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
