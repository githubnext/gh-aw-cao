// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ pageLevelTabs?: boolean, renderMatched: (routeValue: string) => { allocation: Record<string, unknown>, content: HTMLElement | null } | null }} extra */
function shellOptions(extra) {
  return {
    rootClassName: 'shared-route-shell',
    datasetKey: 'workflow',
    selectMessage: 'Select one.',
    notFoundMessage: 'Not found.',
    currentTab: 'reports',
    tabListClassName: 'shared-tabs',
    tabListAriaLabel: (/** @type {string} */ title) => `${title} views`,
    hasSelection: (/** @type {string} */ value) => value.length > 0,
    tabs: (/** @type {{ routeValue: string }} */ { routeValue }) => [
      { id: 'reports', label: 'Reports', icon: 'issue', href: `#reports-${routeValue}` }
    ],
    ...extra
  };
}

describe('route page shell debug logging', () => {
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
    const { createRoutePageShell } = await import('../../src/components/route-page-shell.js');

    const rendered = createRoutePageShell(
      { pageId: 'custom-page', title: 'Custom page', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h3', routeParameter: 'workflow' },
      shellOptions({ renderMatched: () => null })
    );
    document.body.append(rendered);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs matched/not-found outcomes under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-page-shell', output })
      };
    });
    vi.resetModules();
    const { createRoutePageShell } = await import('../../src/components/route-page-shell.js');

    const rendered = createRoutePageShell(
      { pageId: 'custom-page', title: 'Custom page', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h3', routeParameter: 'workflow' },
      shellOptions({
        renderMatched: (routeValue) => routeValue === 'known'
          ? { allocation: { title: 'Demo', description: 'Selected demo' }, content: document.createElement('div') }
          : null
      })
    );
    document.body.append(rendered);

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: '<missing-with-sensitive-text>' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-page-shell]',
      { currentTab: 'reports', outcome: 'not-found' }
    );

    output.debug.mockClear();
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'known' }
    }));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-page-shell]',
      { currentTab: 'reports', outcome: 'matched' }
    );

    // Never log the raw, potentially sensitive route value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }
  });

  it('logs page-level tab placement outcomes', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-page-shell', output })
      };
    });
    vi.resetModules();
    const { createRoutePageShell } = await import('../../src/components/route-page-shell.js');

    const page = Object.assign(document.createElement('div'), { className: 'dashboard-page' });
    document.body.append(page);
    const rendered = createRoutePageShell(
      { pageId: 'custom-page', title: 'Custom page', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h3', routeParameter: 'workflow' },
      shellOptions({
        pageLevelTabs: true,
        renderMatched: (routeValue) => ({
          allocation: { title: 'Demo', description: `Selected ${routeValue}` },
          content: document.createElement('div')
        })
      })
    );
    page.append(rendered);

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'demo' }
    }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-page-shell]',
      { currentTab: 'reports', tabPlacement: 'promoted', hasSelection: true }
    );
  });
});
