import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const schema = {
  'language-version': '1',
  dashboard: {
    pages: [
      { id: 'overview', chunk: 'dashboard-pages/overview.json' },
      { id: 'cost', chunk: 'dashboard-pages/cost.json' },
      { id: 'repository-detail', chunk: 'dashboard-pages/repository-detail.json' }
    ]
  }
};
const chunk = { page: { id: 'cost', views: [] }, queries: [] };

beforeEach(() => {
  vi.resetModules();
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('dashboard definition preloading', () => {
  it('shares concurrent schema and page requests with application startup', async () => {
    const fetch = vi.fn(async (/** @type {string} */ path) =>
      Response.json(path === './dashboard.json' ? schema : chunk));
    vi.stubGlobal('fetch', fetch);
    const definition = await import('../../src/dashboard-definition.js');
    window.location.hash = '#page-cost';

    definition.preloadDashboardDefinition();
    const firstSchema = definition.loadDashboardSchema();
    expect(definition.loadDashboardSchema()).toBe(firstSchema);
    await firstSchema;
    const firstPage = definition.loadDashboardPageChunk('dashboard-pages/cost.json');
    expect(definition.loadDashboardPageChunk('dashboard-pages/cost.json')).toBe(firstPage);
    expect(await firstPage).toEqual(chunk);
    expect(fetch.mock.calls).toEqual([
      ['./dashboard.json', { cache: 'no-store' }],
      ['./dashboard-pages/cost.json', { cache: 'reload' }]
    ]);
  });

  it.each(['', '#unknown', '#page-not-declared', '#page-%E0%A4%A'])(
    'preloads the declared overview for absent or invalid route %s',
    async (hash) => {
      const fetch = vi.fn(async (/** @type {string} */ path) =>
        Response.json(path === './dashboard.json' ? schema : chunk));
      vi.stubGlobal('fetch', fetch);
      window.location.hash = hash;
      const definition = await import('../../src/dashboard-definition.js');

      definition.preloadDashboardDefinition();

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(
        './dashboard-pages/overview.json', { cache: 'reload' }
      ));
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it('uses declared parameterized routes without using route arguments as fetch paths', async () => {
    const fetch = vi.fn(async (/** @type {string} */ path) =>
      Response.json(path === './dashboard.json' ? schema : chunk));
    vi.stubGlobal('fetch', fetch);
    window.location.hash = '#page-repository-detail?repository=owner%2Frepository';
    const definition = await import('../../src/dashboard-definition.js');

    definition.preloadDashboardDefinition();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(
      './dashboard-pages/repository-detail.json', { cache: 'reload' }
    ));
  });

  it('leaves already inlined page definitions alone', async () => {
    const fetch = vi.fn(async () => Response.json({
      dashboard: { pages: [{ id: 'overview', views: [] }] }
    }));
    vi.stubGlobal('fetch', fetch);
    const definition = await import('../../src/dashboard-definition.js');

    definition.preloadDashboardDefinition();
    await definition.loadDashboardSchema();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates schema errors and retries rather than caching rejected requests', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json(schema));
    vi.stubGlobal('fetch', fetch);
    const definition = await import('../../src/dashboard-definition.js');

    await expect(definition.loadDashboardSchema()).rejects.toThrow('Unable to load dashboard.json: 503');
    expect(await definition.loadDashboardSchema()).toEqual(schema);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates page errors and retries failed preloads through the same cache', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(schema))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json(chunk));
    vi.stubGlobal('fetch', fetch);
    window.location.hash = '#page-cost';
    const definition = await import('../../src/dashboard-definition.js');

    definition.preloadDashboardDefinition();
    await definition.loadDashboardSchema();
    await expect(definition.loadDashboardPageChunk('dashboard-pages/cost.json'))
      .rejects.toThrow('Unable to load dashboard page "dashboard-pages/cost.json": 503');
    expect(await definition.loadDashboardPageChunk('dashboard-pages/cost.json')).toEqual(chunk);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
