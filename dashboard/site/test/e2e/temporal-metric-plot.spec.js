import nativeMeasureHistoryQuery from '../fixtures/native-measure-history-query.json' with { type: 'json' };
import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import observations from '../fixtures/campaign-operational-value-observations.json' with { type: 'json' };

registerSmokeRoutes();

for (const { width, history } of [1200, 390].flatMap((width) =>
  ['single', 'gap', 'consecutive', 'legacy-consecutive', 'legacy-gap'].map((history) => ({ width, history })))) {
  const singleObservation = history === 'single';
  const consecutive = history.endsWith('consecutive');
  const rows = (singleObservation ? observations.slice(0, 1) : observations).map((row, index) => ({
    ...row,
    ...(history.startsWith('legacy') ? {} : { 'evaluator-digest': 'a'.repeat(64) }),
    ...(consecutive && index === 1 ? { 'observed-at': '2026-09-23T20:56:21Z' } : {}),
    ...(history.startsWith('legacy') ? { 'cadence-days': undefined } : {})
  }));
  test(`operational-value ${history} tooltip opens the observed run report at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 });
    await context.route('https://github.com/githubnext/gh-cao/actions/runs/101', (route) => route.fulfill({
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
          queries: ${JSON.stringify([nativeMeasureHistoryQuery])},
          sourceNames: ['operational-value-plot-series'],
          sources: {
            'operational-values': {
              source: 'operational-values',
              rows: ${JSON.stringify(rows)},
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
          pageId: 'measurement-query',
          sourceNames: ['operational-value-plot-series'],
          sources,
          elementConfig: { 'measure-source': 'operational-value' },
          contextDetails: [],
          headingTag: 'h3'
        }));
      </script>
    `);
    await expect(page.locator('.temporal-plot-observation-count')).toContainText(
      singleObservation ? '1 observation; trend unavailable' : '2 observation times'
    );
    await expect(page.locator('.temporal-plot-metric')).toHaveCount(consecutive && !history.startsWith('legacy') ? 1 : 0);
    await expect(page.locator('.temporal-plot-evidence-dates')).toContainText('Latest observation is not a live measurement');
    await expect(page.locator('.temporal-plot-trend')).toHaveCount(0);
    await expect(page.locator('.temporal-plot-comparison-note')).not.toBeVisible();
    await expect(page.locator('.temporal-plot-coverage-note')).not.toBeVisible();
    await expect(page.locator('.temporal-plot-continuity-note')).not.toBeVisible();
    await expect(page.locator('.temporal-plot-latest-date')).toBeVisible();
    const disclosure = page.getByText('Evidence details', { exact: true });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.temporal-plot-comparison-note')).toContainText('not a combined trend');
    await expect(page.locator('.temporal-plot-continuity-note')).toContainText('missing provenance');
    await expect(page.locator('.temporal-plot-coverage-note')).toContainText('Source-window coverage is not recorded here');
    await disclosure.click();
    await expect(page.locator('.temporal-plot-coverage-note')).not.toBeVisible();
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
    await expect(report).toHaveURL('https://github.com/githubnext/gh-cao/actions/runs/101');
    await expect(report.getByRole('heading', { name: 'Run report 101' })).toBeVisible();
  });
}
