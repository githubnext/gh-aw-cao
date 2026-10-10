import { buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import contract from '../fixtures/chart-layer-contract.json' with { type: 'json' };
import { getPrimerStyles } from '../../src/styles.js';

registerSmokeRoutes();

for (const theme of ['light', 'dark']) {
  test(`layered charts share coordinates and stay accessible on desktop and mobile in ${theme}`, async ({ page }) => {
    await page.evaluate(async ({ documentModel, presenterUrl, workerUrl, compilerUrl, theme }) => {
      const { renderDashboard } = await import(presenterUrl);
      const { processDataRequest } = await import(workerUrl);
      const { compileDashboardViewPayloadQueries } = await import(compilerUrl);
      const dashboard = documentModel.dashboard;
      const page = dashboard.pages[0];
      const compiled = compileDashboardViewPayloadQueries(page, page.id, { queries: dashboard.queries });
      const metadata = {
        'source-id': 'layers', 'source-kind': 'fixture', 'as-of': '2026-10-01T00:00:00Z',
        'retrieved-at': '2026-10-01T00:00:00Z', availability: 'available', completeness: 'complete', freshness: 'fresh'
      };
      const sources = processDataRequest({
        operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases,
        sources: { usage: { source: 'usage', metadata, rows: [
          { 'observed-at': '2026-10-01', aic: 2, 'estimated-usd': 5 },
          { 'observed-at': '2026-10-02', aic: 4, 'estimated-usd': 5,
            'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42', label: 'Run 42' } },
          { 'observed-at': '2026-10-11', aic: 10, 'estimated-usd': 5 }
        ] } }
      });
      const root = renderDashboard({ document: { languageVersion: '0.1.0', dashboard }, sources });
      root.dataset.theme = theme;
      document.querySelector('#root')?.append(root);
    }, { documentModel: structuredClone(contract), presenterUrl: buildPresenterModuleUrl(),
      workerUrl: 'http://dashboard.test/src/data-worker.js',
      compilerUrl: 'http://dashboard.test/src/data/queries/view-payload-compiler.js', theme });
    await page.addStyleTag({ content: getPrimerStyles() });
    const view = page.locator('[data-view-id="observations"]');
    await expect(view.locator('[data-chart-layer]')).toHaveCount(4);
    await expect(view.locator('svg')).toHaveCount(1);
    await expect(view.locator('.chart-legend li')).toHaveCount(2);
    const links = view.locator('[data-chart-layer-type="dot"] a');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', 'https://github.com/githubnext/gh-aw-cao/actions/runs/42');
    await links.focus();
    await expect(links).toBeFocused();
    await expect(links).toHaveAccessibleName(/4.*AI credits.*Run 42/);

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      await page.setViewportSize(viewport);
      await expect(view.locator('.layer-chart-widget')).toBeVisible();
      const bounds = await view.locator('svg').boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error('Layered chart has no layout');
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(await view.locator('svg').evaluate((svg) => {
        const line = svg.querySelector('[data-chart-layer-type="line"] polyline')?.getAttribute('points')?.split(' ').map((pair) => pair.split(',').map(Number));
        const dots = svg.querySelectorAll('[data-chart-layer-type="dot"] circle');
        return [...dots].every((dot, index) => Number(dot.getAttribute('cx')) === line?.[index][0]
          && Number(dot.getAttribute('cy')) === line?.[index][1]);
      })).toBe(true);
    }
  });
}
