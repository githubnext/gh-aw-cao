import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('Memory uses mobile master-detail file navigation', async ({ context, page }) => {
  const content = '# Mobile memory\n\nA readable file on a small screen.\n';
  await context.route('http://dashboard.test/memory/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/memory/manifest.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          campaigns: [{
            campaign: 'ambient-context',
            branch: 'memory/ambient-context',
            commit: 'a'.repeat(40),
            files: [{ path: 'notes/mobile.md', oid: 'b'.repeat(40), size: content.length }],
            omitted: {},
          }],
        }),
      });
      return;
    }
    if (path === '/memory/ambient-context/notes/mobile.md') {
      await route.fulfill({ contentType: 'text/plain', body: content });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderCampaignMemory } from '/src/components/campaign-memory.js';
      import { primerStylesheet } from '/src/styles.js';
      const style = document.createElement('style');
      style.textContent = primerStylesheet();
      document.head.append(style);
      document.querySelector('#root').append(renderCampaignMemory({
        campaignId: 'ambient-context',
        campaignName: 'Ambient Context'
      }));
    </script>
  `);

  const browser = page.getByRole('region', { name: 'Ambient Context repository memory' });
  const layout = browser.locator('.campaign-memory-layout');
  const files = browser.getByLabel('Ambient Context memory files');
  const fileContent = browser.locator('.campaign-memory-content');
  await expect(files).toBeVisible();
  await expect(fileContent).toBeHidden();
  await expect(layout).toHaveAttribute('data-memory-view', 'browser');

  await browser.getByRole('button', { name: /notes\/mobile\.md/ }).click();
  await expect(layout).toHaveAttribute('data-memory-view', 'file');
  await expect(files).toBeHidden();
  await expect(fileContent).toBeVisible();
  await expect(fileContent.getByRole('heading', { name: 'notes/mobile.md' })).toBeVisible();
  await expect(fileContent.locator('pre')).toContainText('A readable file on a small screen.');

  await fileContent.getByRole('button', { name: 'Back to files' }).click();
  await expect(layout).toHaveAttribute('data-memory-view', 'browser');
  await expect(files).toBeVisible();
  await expect(fileContent).toBeHidden();
});
