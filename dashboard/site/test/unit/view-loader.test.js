import { describe, expect, it, vi } from 'vitest';
import { resolveDashboardPageViews } from '../../src/view-loader.js';

describe('dashboard view loader', () => {
  it('loads only the requested page and caches its resolved views', async () => {
    const document = {
      dashboard: {
        pages: [
          { id: 'startup', kind: 'custom', views: [{ $ref: './views/startup/summary.json' }] },
          { id: 'secondary', kind: 'custom', views: [{ $ref: './views/secondary/table.json' }] }
        ]
      }
    };
    const fetchView = vi.fn(async (/** @type {URL} */ url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: url.pathname.includes('summary') ? 'summary' : 'table',
        mark: 'table',
        data: { source: 'runs' },
        encoding: { columns: [{ field: 'run', type: 'nominal' }] }
      })
    }));

    await resolveDashboardPageViews(document, 'startup', {
      baseUrl: 'https://dashboard.test/dashboard.json',
      fetch: fetchView
    });
    await resolveDashboardPageViews(document, 'startup', {
      baseUrl: 'https://dashboard.test/dashboard.json',
      fetch: fetchView
    });

    expect(fetchView).toHaveBeenCalledOnce();
    expect(fetchView.mock.calls[0][0].href).toBe('https://dashboard.test/views/startup/summary.json');
    expect(/** @type {any} */ (document.dashboard.pages[0].views[0]).id).toBe('summary');
    expect(document.dashboard.pages[1].views[0]).toEqual({ $ref: './views/secondary/table.json' });
  });

  it('rejects an invalid referenced view payload', async () => {
    const document = {
      dashboard: {
        pages: [{ id: 'broken', kind: 'custom', views: [{ $ref: './views/broken/view.json' }] }]
      }
    };

    await expect(resolveDashboardPageViews(document, 'broken', {
      baseUrl: 'https://dashboard.test/dashboard.json',
      fetch: async () => ({ ok: true, status: 200, json: async () => [] })
    })).rejects.toThrow('must contain a view mapping');
  });
});
