// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {HTMLElement} root @returns {HTMLElement} */
function appendFullViewPage(root) {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = '<div class="custom-view" data-view-layout="full-view"></div>';
  root.append(page);
  return page;
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  document.body.replaceChildren();
});

describe('full-view-scroll debug logging', () => {
  it('keeps operational-value plots on the normal page scroll surface before an audit list', async () => {
    const { syncFullViewMode } = await import('../../src/components/full-view-scroll.js');
    const root = document.createElement('div');
    root.innerHTML = '<div class="page" data-view-mode="table"><div class="custom-view"><article class="temporal-metric-plot"></article></div><div class="custom-view" data-view-layout="full-view"></div></div>';
    const page = /** @type {HTMLElement} */ (root.firstElementChild);
    document.body.append(root);

    syncFullViewMode(root, page);

    expect(root.classList.contains('dashboard-full-view')).toBe(false);
    root.classList.add('dashboard-full-view-scrolled');
    syncFullViewMode(root, page);
    expect(root.classList.contains('dashboard-full-view-scrolled')).toBe(false);
  });

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
    const { syncFullViewMode } = await import('../../src/components/full-view-scroll.js');

    const root = document.createElement('div');
    document.body.append(root);
    const page = appendFullViewPage(root);

    syncFullViewMode(root, page);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs pin-changed only on transitions under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=full-view-scroll', output })
      };
    });
    vi.resetModules();
    const { syncFullViewMode } = await import('../../src/components/full-view-scroll.js');

    const root = document.createElement('div');
    document.body.append(root);
    const page = appendFullViewPage(root);

    syncFullViewMode(root, page);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:full-view-scroll]',
      { event: 'pin-changed', pinned: true, selectedFullViewMode: false }
    );

    output.debug.mockClear();
    syncFullViewMode(root, page);
    expect(output.debug).not.toHaveBeenCalled();

    output.debug.mockClear();
    const emptyPage = document.createElement('div');
    syncFullViewMode(root, emptyPage);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:full-view-scroll]',
      { event: 'pin-changed', pinned: false, selectedFullViewMode: false }
    );
  });

  it('logs forwarding-disposed when scroll forwarding is torn down', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=full-view-scroll', output })
      };
    });
    vi.resetModules();
    const { enableFullViewScrollForwarding } = await import('../../src/components/full-view-scroll.js');

    const root = document.createElement('div');
    document.body.append(root);
    const dispose = enableFullViewScrollForwarding(root, null);

    expect(output.debug).not.toHaveBeenCalled();
    dispose();
    expect(output.debug).toHaveBeenCalledWith('[cao:full-view-scroll]', { event: 'forwarding-disposed' });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=full-view-scroll', output })
      };
    });
    vi.resetModules();
    const { syncFullViewMode, enableFullViewScrollForwarding } = await import('../../src/components/full-view-scroll.js');

    const root = document.createElement('div');
    document.body.append(root);
    const page = appendFullViewPage(root);
    syncFullViewMode(root, page);
    enableFullViewScrollForwarding(root, null)();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
