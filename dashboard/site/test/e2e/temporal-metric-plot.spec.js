import { authoritativeDashboard, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import observations from '../fixtures/campaign-operational-value-observations.json' with { type: 'json' };

registerSmokeRoutes();

for (const width of [1200, 390]) {
  test(`operational-value tooltip opens the observed run report at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 });
    await context.route('https://github.com/githubnext/gh-aw-cao/actions/runs/101', (route) => route.fulfill({
      contentType: 'text/html', body: '<h1>Run report 101</h1>'
    }));
    await page.setContent(`
      <div id="root"></div>
      <script type="module">
        import { processDataRequest } from 'http://dashboard.test/src/data-worker.js';
        import { renderMeasureHistory } from 'http://dashboard.test/src/components/measure-history.js';
        import { primerStyles } from 'http://dashboard.test/src/styles-primer.js';
        const style = document.createElement('style');
        style.textContent = primerStyles;
        document.head.append(style);
        const sources = processDataRequest({
          operation: 'execute-dashboard-queries',
          queries: ${JSON.stringify(authoritativeDashboard.dashboard.queries)},
          sourceNames: ['campaign-operational-value-primary-series'],
          sources: {
            'operational-values': {
              source: 'operational-values',
              rows: ${JSON.stringify(observations)},
              metadata: {
                'source-id': 'value-fixture', 'source-kind': 'fixture',
                'as-of': '2026-09-24T20:56:21Z', 'retrieved-at': '2026-09-24T20:56:21Z',
                completeness: 'complete', freshness: 'fresh', availability: 'available'
              }
            }
          }
        });
        document.querySelector('#root').append(renderMeasureHistory({
          title: 'Repository operational value',
          pageId: 'campaign-insights',
          sourceNames: ['campaign-operational-value-primary-series'],
          sources,
          elementConfig: { 'measure-source': 'operational-value' },
          contextDetails: [],
          headingTag: 'h3'
        }));
      </script>
    `);
    const point = page.locator('.temporal-plot-point-trigger').first();
    await point.hover();
    const link = page.getByRole('link', { name: 'View run 101' });
    await expect(link).toBeVisible();
    await link.hover();
    await expect(link).toBeVisible();
    await point.focus();
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    const bounds = await link.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    const popup = page.waitForEvent('popup');
    await page.keyboard.press('Enter');
    const report = await popup;
    await expect(report).toHaveURL('https://github.com/githubnext/gh-aw-cao/actions/runs/101');
    await expect(report.getByRole('heading', { name: 'Run report 101' })).toBeVisible();
  });
}
