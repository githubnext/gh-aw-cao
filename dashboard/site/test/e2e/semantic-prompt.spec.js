import { authoritativeDashboard, buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('a chart with composed semantics offers a prompt preview and returns focus', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const metadata = {
        'source-id': 'cost-by-campaign', 'source-kind': 'fixture',
        'as-of': '2026-09-01T00:00:00Z', 'retrieved-at': '2026-09-01T00:00:00Z',
        availability: 'available', completeness: 'complete', freshness: 'fresh'
      };
      document.querySelector('#root').append(renderDashboard({
        document: ${JSON.stringify(authoritativeDashboard)},
        sources: {
          'cost-by-campaign': {
            source: 'cost-by-campaign',
            rows: [{ 'campaign-name': 'Campaign A', aic: 12 }],
            metadata
          }
        }
      }));
    </script>
  `);
  await page.evaluate(() => { window.location.hash = '#page-cost'; });
  const action = page.locator('[data-view-id="cost-by-campaign"] .table-intent-button');
  await expect(action).toBeVisible();
  await action.click();
  const dialog = page.locator('[data-view-id="cost-by-campaign"] .table-intent-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.table-intent-preview')).toContainText('Named CAO query IDs:');
  await expect(dialog.locator('.table-intent-preview')).toContainText('Any unusual campaign cost is explained');
  await dialog.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(action).toBeFocused();
});
