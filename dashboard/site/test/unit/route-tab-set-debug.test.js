// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const tabs = [
  { id: 'insights', label: 'Insights', icon: 'graph', href: '#page-insights' },
  { id: 'reports', label: 'Reports', icon: 'issue', href: '#page-reports' }
];

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importRouteTabSetWithDebug({ search, output }) {
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
  return import('../../src/components/route-tab-set.js');
}

describe('route-tab-set debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabSetWithDebug({ search: '', output });

    module.renderRouteTabSet({ className: 'route-tabs', ariaLabel: 'Views', currentTab: 'reports', tabs });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "route-tab-set" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabSetWithDebug({ search: '?debug=some-other-category', output });

    module.renderRouteTabSet({ className: 'route-tabs', ariaLabel: 'Views', currentTab: 'reports', tabs });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a "composed" event with tab count and current-tab match status when enabled', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabSetWithDebug({ search: '?debug=route-tab-set', output });

    module.renderRouteTabSet({ className: 'route-tabs', ariaLabel: 'Views', currentTab: 'reports', tabs });
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tab-set]', {
      event: 'composed',
      tabCount: 2,
      hasCurrentMatch: true
    });

    output.debug.mockClear();
    module.renderRouteTabSet({ className: 'route-tabs', ariaLabel: 'Views', currentTab: 'missing-tab', tabs });
    expect(output.debug).toHaveBeenCalledWith('[cao:route-tab-set]', {
      event: 'composed',
      tabCount: 2,
      hasCurrentMatch: false
    });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importRouteTabSetWithDebug({ search: '?debug=route-tab-set', output });

    module.renderRouteTabSet({
      className: 'route-tabs',
      ariaLabel: 'Views',
      currentTab: 'reports',
      tabs: [
        {
          id: 'insights',
          label: 'Insights',
          icon: 'graph',
          href: '#page-insights',
          routeTitle: 'Secret Campaign Name',
          routeDescription: 'Operational activity with sensitive details.'
        },
        { id: 'reports', label: 'Reports', icon: 'issue', href: '#page-reports' }
      ]
    });

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
