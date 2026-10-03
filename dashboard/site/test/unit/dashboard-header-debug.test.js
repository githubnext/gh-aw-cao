// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const overviewPageHref = '#page-overview';
const githubUrlBase = 'https://github.example.com';
const dashboardRepository = 'octo-org/agentic-operations';

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importDashboardHeaderWithDebug({ search, output }) {
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
  return import('../../src/components/dashboard-header.js');
}

/** @param {Partial<Parameters<typeof import('../../src/components/dashboard-header.js').renderDashboardHeader>[0]>} overrides */
function headerOptions(overrides = {}) {
  return {
    title: 'Overview',
    overviewPageHref,
    dashboardHorizon: /** @type {any} */ (document.createElement('div')),
    accountMenu: null,
    githubUrlBase,
    dashboardRepository: null,
    ...overrides
  };
}

describe('dashboard-header debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardHeader } = await importDashboardHeaderWithDebug({ search: '', output });

    renderDashboardHeader(headerOptions());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "dashboard-header" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardHeader } = await importDashboardHeaderWithDebug({ search: '?debug=some-other-category', output });

    renderDashboardHeader(headerOptions());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the initial render with coarse boolean metadata under its category when enabled', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardHeader } = await importDashboardHeaderWithDebug({ search: '?debug=dashboard-header', output });

    renderDashboardHeader(headerOptions({
      title: 'Overview',
      description: 'Operational activity',
      experimental: true,
      accountMenu: /** @type {any} */ (document.createElement('div')),
      dashboardRepository
    }));

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-header]', {
      event: 'initial-render',
      hasTitle: true,
      experimental: true,
      hasDescription: true,
      hasRepositoryLink: true,
      hasAccountMenu: true
    });
  });

  it('logs false flags for an untitled, non-experimental page without a description, repository link, or account menu, without leaking raw values', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardHeader } = await importDashboardHeaderWithDebug({ search: '?debug=dashboard-header', output });

    renderDashboardHeader(headerOptions({ title: '' }));

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-header]', {
      event: 'initial-render',
      hasTitle: false,
      experimental: false,
      hasDescription: false,
      hasRepositoryLink: false,
      hasAccountMenu: false
    });

    for (const call of output.debug.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain(dashboardRepository);
    }
  });
});
