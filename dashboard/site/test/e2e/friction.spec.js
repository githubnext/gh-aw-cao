import { authoritativeDashboard, buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import { getPrimerStyles } from '../../src/styles.js';

registerSmokeRoutes();

for (const width of [390, 1280]) {
  test(`Friction keeps positive cost visible after more than ten alphabetically earlier zero-cost workflows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`
      <div id="root"></div>
      <script type="module">
        import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
        import { processDataRequest } from 'http://dashboard.test/src/data-worker.js';
        const document = ${JSON.stringify(authoritativeDashboard)};
        const metadata = {
          'source-id': 'friction-fixture', 'source-kind': 'fixture',
          'as-of': '2026-10-20T12:00:00Z', 'retrieved-at': '2026-10-20T12:00:00Z',
          availability: 'available', completeness: 'complete', freshness: 'fresh'
        };
        const rows = Array.from({ length: 12 }, (_, index) => ({
          organization: 'org', repository: 'repo', workflow: 'a-zero-' + index,
          run: String(index), aic: 0, 'measurement-state': 'measured'
        }));
        rows.push({
          organization: 'org', repository: 'repo', workflow: 'z-positive',
          run: '42', aic: 2, 'measurement-state': 'measured'
        });
        const sources = await processDataRequest({
          operation: 'execute-dashboard-queries',
          queries: document.dashboard.queries,
          sourceNames: ['friction-by-workflow', 'friction-observations'],
          sources: { friction: { source: 'friction', rows, metadata } }
        });
        window.location.hash = '#page-friction';
        globalThis.document.querySelector('#root').append(renderDashboard({ document, sources }));
      </script>
    `);
    await page.addStyleTag({ content: getPrimerStyles() });
    const view = page.locator('[data-view-id="friction-by-workflow"]');
    await expect(view.locator('.chart-legend-pie li')).toHaveCount(1);
    await expect(view.locator('.chart-legend-pie')).toContainText('z-positive');
    await expect(view).not.toContainText('No data is available');
  });
}
