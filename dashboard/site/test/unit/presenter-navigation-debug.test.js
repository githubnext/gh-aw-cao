import { expect, it, vi } from 'vitest';

it('logs and ignores navigation indicator source failures', async () => {
  const originalUrl = window.location.href;
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  window.history.replaceState({}, '', '?debug=render:navigation');
  vi.resetModules();
  try {
    const { renderDashboard, disposeDashboard } = await import('../../src/presenter.js');
    const document = /** @type {import('../../src/presenter.js').PresentationDocument} */ ({
      languageVersion: '0.1.0',
      dashboard: {
        id: 'indicator-dashboard',
        title: 'Indicator dashboard',
        pages: [{
          id: 'maintenance',
          kind: 'custom',
          title: 'Updates',
          views: [],
          'navigation-indicator': {
            label: 'updates available',
            any: ['maintenance-campaign-updates']
          }
        }]
      }
    });
    const loadPageSources = /** @type {import('../../src/presenter.js').PageSourceLoader} */ (vi.fn(() => Promise.resolve({})));
    loadPageSources.subscribeBackgroundSources = vi.fn(() => Promise.reject(new Error('unavailable')));
    const rendered = renderDashboard({ document, sources: {}, loadPageSources });
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith('[cao:render:navigation]', 'indicator update failed', { error: 'unavailable' });
    });
    disposeDashboard(rendered);
  } finally {
    window.history.replaceState({}, '', originalUrl);
    debug.mockRestore();
    vi.resetModules();
  }
});
