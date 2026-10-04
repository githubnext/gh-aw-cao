// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importDashboardFrameWithDebug({ search, output }) {
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
  return import('../../src/components/dashboard-frame.js');
}

/** @param {Partial<Parameters<typeof import('../../src/components/dashboard-frame.js').renderDashboardFrame>[0]>} overrides */
function frameOptions(overrides = {}) {
  return {
    navigation: /** @type {any} */ (document.createElement('nav')),
    header: /** @type {any} */ (document.createElement('header')),
    callouts: null,
    pages: [],
    footer: /** @type {any} */ (document.createElement('footer')),
    ...overrides
  };
}

describe('dashboard-frame debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFrame } = await importDashboardFrameWithDebug({ search: '', output });

    renderDashboardFrame(frameOptions());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "dashboard-frame" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFrame } = await importDashboardFrameWithDebug({ search: '?debug=some-other-category', output });

    renderDashboardFrame(frameOptions());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the composed shell with page count and callouts presence when enabled', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFrame } = await importDashboardFrameWithDebug({ search: '?debug=dashboard-frame', output });

    renderDashboardFrame(frameOptions({
      callouts: /** @type {any} */ (document.createElement('div')),
      pages: [
        /** @type {any} */ (document.createElement('section')),
        /** @type {any} */ (document.createElement('section'))
      ]
    }));

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-frame]', {
      event: 'composed',
      pageCount: 2,
      hasCallouts: true
    });
  });

  it('logs zero pages and no callouts without leaking page or callout content', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFrame } = await importDashboardFrameWithDebug({ search: '?debug=dashboard-frame', output });

    renderDashboardFrame(frameOptions());

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-frame]', {
      event: 'composed',
      pageCount: 0,
      hasCallouts: false
    });

    for (const call of output.debug.mock.calls) {
      expect(call[1]).not.toHaveProperty('navigation');
      expect(call[1]).not.toHaveProperty('header');
      expect(call[1]).not.toHaveProperty('pages');
      expect(call[1]).not.toHaveProperty('footer');
    }
  });
});
