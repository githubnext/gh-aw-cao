// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const tabs = [
  { id: 'overview', label: 'Overview', icon: 'repo', page: 'repository-detail' },
  { id: 'settings', label: 'Settings', icon: 'gear', page: 'repository-settings' }
];

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importRouteTabsWithDebug({ search, output }) {
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
  return import('../../src/components/route-tabs.js');
}

describe('route-tabs debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabsWithDebug({ search: '', output });

    module.declaredRouteTabs({ tabs, tab: 'settings' });
    const element = module.renderDeclaredRouteTabs({ routeParameter: 'repository', currentTab: 'settings', tabs });
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo-repo' }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "route-tabs" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabsWithDebug({ search: '?debug=some-other-category', output });

    module.declaredRouteTabs({ tabs, tab: 'settings' });
    const element = module.renderDeclaredRouteTabs({ routeParameter: 'repository', currentTab: 'settings', tabs });
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo-repo' }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs cleared, rendered, and declared-tabs-parsed/empty events under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabsWithDebug({ search: '?debug=route-tabs', output });

    const parsed = module.declaredRouteTabs({ tabs, tab: 'settings' });
    expect(parsed).not.toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tabs]', { event: 'declared-tabs-parsed', tabCount: 2 });

    output.debug.mockClear();
    const empty = module.declaredRouteTabs({ tabs: [{ id: 'overview' }] });
    expect(empty).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tabs]', { event: 'declared-tabs-empty' });

    output.debug.mockClear();
    const element = module.renderDeclaredRouteTabs({ routeParameter: 'repository', currentTab: 'settings', tabs });
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo-repo' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tabs]', { event: 'rendered', parameter: 'repository', tabCount: 2, currentTab: 'settings' });

    output.debug.mockClear();
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: '  ' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tabs]', { event: 'cleared', parameter: 'repository' });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabsWithDebug({ search: '?debug=route-tabs', output });

    module.declaredRouteTabs({ tabs, tab: 'settings' });
    const element = module.renderDeclaredRouteTabs({ routeParameter: 'repository', currentTab: 'settings', tabs });
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo repo with spaces' }
    }));

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
