import { authoritativeDashboard, buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import { getPrimerStyles } from '../../src/styles.js';

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
  await page.addStyleTag({ content: getPrimerStyles() });
  await page.evaluate(() => { window.location.hash = '#page-cost'; });
  const action = page.locator('[data-view-id="cost-by-campaign"] .table-intent-button');
  await expect(action).toBeVisible();
  const titleRow = page.locator('[data-view-id="cost-by-campaign"] .chart-prompt-heading');
  await expect(titleRow.locator('h3, h4')).toBeVisible();
  await expect(action.locator('.octicon')).toBeVisible();
  await expect(action).toHaveAttribute('aria-label', /Fix it: /);
  await expect(action.locator('span')).toBeHidden();
  const titleBox = await titleRow.locator('h3, h4').boundingBox();
  const buttonBox = await action.boundingBox();
  if (!titleBox || !buttonBox) throw new Error('Chart title and prompt button must be visible.');
  expect(buttonBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(buttonBox.y).toBeLessThan(titleBox.y + titleBox.height);
  await action.click();
  const dialog = page.locator('[data-view-id="cost-by-campaign"] .table-intent-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.table-intent-preview')).toContainText('Named CAO query IDs:');
  await expect(dialog.locator('.table-intent-preview')).toContainText('Any unusual campaign cost is explained');
  await dialog.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(action).toBeFocused();
});

test('an open shared prompt preview tracks reactive evidence until it closes', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderPromptPreviewAction } from ${JSON.stringify('http://dashboard.test/src/components/data-view.js')};
      import { state } from ${JSON.stringify('http://dashboard.test/src/reactive.js')};
      const evidence = state('first observation');
      const action = renderPromptPreviewAction('Inspect evidence', evidence.get, undefined, 'comment', 'semantic-prompt');
      window.refreshEvidence = () => evidence.set('updated observation');
      document.querySelector('#root').append(action);
    </script>
  `);
  await page.getByRole('button', { name: 'Inspect evidence' }).click();
  const preview = page.locator('.table-intent-preview');
  await expect(preview).toHaveText('first observation');
  await page.evaluate(() => Reflect.get(window, 'refreshEvidence')());
  await expect(preview).toHaveText('updated observation');
  await page.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(page.getByRole('button', { name: 'Inspect evidence' })).toBeFocused();
});
