import { authoritativeDashboard, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('repository run chart loads without imported events and stays subscribed across refreshes', async ({ page }) => {
  const dashboard = authoritativeDashboard.dashboard;
  const template = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'repositories');
  const model = {
    ...authoritativeDashboard,
    dashboard: {
      ...dashboard,
      pages: [{
        ...template,
        definition: {
          ...template.definition,
          views: template.definition.views.filter((/** @type {{ id: string }} */ view) => view.id === 'repositories-runs')
        }
      }]
    }
  };
  let updated = false;
  await page.route('http://dashboard.test/repository-sources.json', async (route) => {
    const now = new Date().toISOString();
    const identity = { organization: 'octo', repository: 'repo', workflow: '.github/workflows/worker.md' };
    const metadata = {
      'as-of': now, 'artifact-generation': updated ? 'updated' : 'initial',
      completeness: 'complete', freshness: 'fresh'
    };
    const runs = [
      { ...identity, run: '1', 'run-attempt': 1 },
      { ...identity, run: '1', 'run-attempt': 2 },
      { ...identity, workflow: '.github/workflows/local.md', run: '3', 'run-attempt': 1 },
      ...(updated ? [{ ...identity, run: '2', 'run-attempt': 1 }] : [])
    ].map((run) => ({ ...run, 'started-at': now, 'run-status': 'completed', 'run-conclusion': 'success' }));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        repositories: {
          rows: [{
            organization: 'octo', repository: 'repo',
            'repository-link': { href: 'https://github.com/octo/repo', relation: 'repository' }
          }, { organization: 'octo', repository: 'idle' }],
          metadata
        },
        workflows: {
          rows: [
            { ...identity, 'workflow-role': 'standalone', 'inventory-ready': false },
            { ...identity, workflow: '.github/workflows/local.md', 'workflow-role': 'standalone', 'workflow-registry-state': 'active' }
          ],
          metadata
        },
        runs: { rows: runs, metadata }
      })
    });
  });
  await page.evaluate(async (documentModel) => {
    const { renderDashboard, dashboardPageSourceNames } = await import(`${location.origin}/src/presenter.js`);
    const { loadCanonicalDashboardSources, subscribeCanonicalDashboardView } = await import(`${location.origin}/src/data-processor.js`);
    const context = {
      pages: documentModel.dashboard.pages, queries: documentModel.dashboard.queries,
      views: documentModel.dashboard.views, githubUrlBase: 'https://github.com'
    };
    await loadCanonicalDashboardSources(`${location.origin}/repository-sources.json`, [], context);
    /** @type {import('../../src/presenter.js').PageSourceLoader} */
    const loader = (pageId, options) => new Promise((resolve, reject) => {
      let initial = true;
      subscribeCanonicalDashboardView(
        'repository-run-inventory',
        dashboardPageSourceNames(documentModel, pageId, options.queryContext?.viewMode),
        context,
        (/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ sources) => {
          if (initial) { initial = false; resolve(sources); }
          else options.onUpdate(sources);
        },
        undefined,
        { ...options, pageId, onError: reject }
      );
    });
    location.hash = '#page-repositories';
    document.querySelector('#root')?.replaceChildren(renderDashboard({
      document: documentModel, sources: {}, loadPageSources: loader
    }));
  }, model);

  const chart = page.locator('[data-view-id="repositories-runs"]');
  await expect(chart.getByRole('img', { name: 'octo/repo: 2 (Centrally managed: 1; Repository-owned: 1)', exact: true })).toBeVisible();
  await expect(chart.getByRole('img', { name: 'octo/idle: 0, Unclassified', exact: true })).toBeVisible();
  await expect(chart.locator('a[href="#page-repository-detail?repository=octo%2Frepo"]').first()).toBeVisible();
  updated = true;
  await page.evaluate(async (documentModel) => {
    const { refreshCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
    await refreshCanonicalDashboardSources(`${location.origin}/repository-sources.json`, [], {
      pages: documentModel.dashboard.pages, queries: documentModel.dashboard.queries,
      views: documentModel.dashboard.views, githubUrlBase: 'https://github.com'
    });
  }, model);
  await expect(chart.getByRole('img', { name: 'octo/repo: 3 (Centrally managed: 2; Repository-owned: 1)', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chart.getByRole('img', { name: 'octo/repo: 3 (Centrally managed: 2; Repository-owned: 1)', exact: true })).toBeVisible();
});
