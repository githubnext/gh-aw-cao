import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('administrator can inspect server logs in a full settings view and return with focus', async ({ page }) => {
  await page.route('**/api/admin/logs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ logs: [{ message: 'server ready' }], redis: { status: 'ok' } })
  }));
  await page.evaluate(async ({ viewUrl, stylesUrl }) => {
    const meta = document.createElement('meta');
    meta.name = 'dashboard-data-backend';
    meta.content = 'server-http';
    document.head.append(meta);
    const [{ renderConfigurationView }, { primerStylesheet }] = await Promise.all([
      import(viewUrl),
      import(stylesUrl)
    ]);
    const style = document.createElement('style');
    style.textContent = primerStylesheet();
    document.head.append(style);
    document.querySelector('#root')?.append(renderConfigurationView({
      pageId: 'configuration',
      title: 'Settings',
      description: 'Dashboard settings.',
      sourceNames: ['configuration-policy'],
      sources: { 'configuration-policy': { rows: [{ document: { version: 1 } }] } },
      contextDetails: [],
      headingTag: 'h3'
    }));
  }, {
    viewUrl: 'http://dashboard.test/src/components/configuration-view.js',
    stylesUrl: 'http://dashboard.test/src/styles.js'
  });
  const settings = page.locator('.configuration-view');
  const open = settings.getByRole('button', { name: 'Server logs' });
  await expect(open).toBeVisible();
  await open.click();
  await expect(settings.getByRole('heading', { name: 'Server logs' })).toBeVisible();
  await expect(settings.locator('pre code')).toContainText('server ready');
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeHidden();
  await settings.getByRole('button', { name: 'Back to settings' }).click();
  await expect(open).toBeFocused();
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
});
