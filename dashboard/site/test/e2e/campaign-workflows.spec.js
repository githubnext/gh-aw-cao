import { authoritativeDashboard, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

for (const width of [1440, 390]) {
  test(`campaign workflow evidence stays scoped and subscribed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const template = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'campaign-workflows');
    const model = {
      ...authoritativeDashboard,
      dashboard: {
        ...authoritativeDashboard.dashboard,
        pages: authoritativeDashboard.dashboard.pages.filter((/** @type {{ id: string }} */ page) => page.id === 'overview' || page === template)
      }
    };
    let updated = false;
    await page.route('http://dashboard.test/campaign-sources.json', async route => {
      const now = new Date().toISOString();
      const identity = { organization: 'example', repository: 'control' };
      const metadata = {
        'as-of': now, 'retrieved-at': now, 'artifact-generation': updated ? 'updated' : 'initial',
        completeness: 'complete', freshness: 'fresh'
      };
      const workflows = ['selected', 'inactive', 'unknown', 'other'].map(workflow => ({
        ...identity, workflow, campaign: workflow === 'other' ? 'other' : 'sample',
        'workflow-role': 'worker', 'workflow-active': workflow === 'inactive' ? 'false' : workflow === 'unknown' ? 'unknown' : 'true'
      }));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          campaigns: { metadata, rows: [{ campaign: 'sample' }, { campaign: 'empty' }, { campaign: 'other' }] },
          repositories: { metadata, rows: [identity] },
          workflows: { metadata, rows: workflows },
          runs: {
            metadata, rows: [1, ...(updated ? [2] : [])].map(run => ({
              ...identity, workflow: 'selected', run: String(run), 'run-attempt': 1,
              'started-at': now, 'run-status': 'completed', 'run-conclusion': 'success', 'aic-total': 0.5
            }))
          },
          ...Object.fromEntries(['audits', 'domains', 'tools', 'issues'].map(name => [name, { metadata, rows: [] }]))
        })
      });
    });
    await page.evaluate(async documentModel => {
      const { renderDashboard, dashboardPageSourceNames } = /** @type {typeof import('../../src/presenter.js')} */ (await import(`${location.origin}/src/presenter.js`));
      const { loadCanonicalDashboardSources, subscribeCanonicalDashboardView } = /** @type {typeof import('../../src/data-processor.js')} */ (await import(`${location.origin}/src/data-processor.js`));
      const context = {
        pages: documentModel.dashboard.pages, queries: documentModel.dashboard.queries,
        views: documentModel.dashboard.views
      };
      await loadCanonicalDashboardSources(`${location.origin}/campaign-sources.json`, [], context);
      /** @type {import('../../src/presenter.js').PageSourceLoader} */
      const loader = (pageId, options) => new Promise((resolve, reject) => {
        let initial = true;
        subscribeCanonicalDashboardView(
          'campaign-workflow-test',
          dashboardPageSourceNames(documentModel, pageId, options.queryContext?.viewMode),
          context,
          sources => {
            if (initial) { initial = false; resolve(sources); }
            else options.onUpdate(sources);
          },
          undefined,
          { ...options, pageId, onError: reject }
        );
      });
      location.hash = '#page-campaign-workflows?campaign=sample';
      document.querySelector('#root')?.replaceChildren(renderDashboard({
        document: documentModel, sources: {}, loadPageSources: loader
      }));
    }, model);
    const view = page.locator('[data-view-id="campaign-workflow-table"]');
    await expect(view.locator('tbody > tr')).toHaveCount(1);
    const row = view.locator('tbody > tr').first();
    await expect(row).toContainText('selected');
    await expect(row.locator('[data-field="runs"]')).toHaveText('1');
    await expect(row.locator('a[href="#page-workflow-runtime?workflow=example%2Fcontrol%3Aselected"]').first()).toBeAttached();
    updated = true;
    await page.evaluate(async documentModel => {
      const { refreshCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
      await refreshCanonicalDashboardSources(`${location.origin}/campaign-sources.json`, [], {
        pages: documentModel.dashboard.pages, queries: documentModel.dashboard.queries, views: documentModel.dashboard.views
      });
    }, model);
    await expect(row.locator('[data-field="runs"]')).toHaveText('2');
    await page.evaluate(() => { location.hash = '#page-campaign-workflows?campaign=empty'; });
    await expect(view).toContainText('No orchestrator or worker workflows are configured for this campaign.');
    await page.evaluate(() => { location.hash = '#page-campaign-workflows?campaign=sample'; });
    await expect(view.locator('tbody > tr')).toHaveCount(1);
    await expect(view.locator('tbody > tr').first().locator('[data-field="runs"]')).toHaveText('2');
  });
}
