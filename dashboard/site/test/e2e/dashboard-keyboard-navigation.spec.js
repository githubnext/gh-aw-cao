import { buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('dashboard sidebar and mobile view menu support directional focus without navigating', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'keyboard-navigation',
            title: 'Keyboard Navigation',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', views: [] },
              { id: 'issues', kind: 'custom', title: 'Issues', views: [] }
            ],
            navigation: [
              { label: 'Main', pages: ['overview', 'runs'] },
              { label: 'Other', pages: ['issues'] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const overview = nav.getByRole('link', { name: 'Overview' });
  const runs = nav.getByRole('link', { name: 'Runs' });
  const other = nav.locator('.nav-section[data-nav-section="Other"]');
  await overview.focus();
  await page.keyboard.press('ArrowDown');
  await expect(runs).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(other.locator('summary')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(other).toHaveAttribute('open', '');
  await page.keyboard.press('ArrowRight');
  await expect(other.getByRole('link', { name: 'Issues' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(other.locator('summary')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator('.mobile-nav-menu');
  await menu.locator(':scope > summary').click();
  await menu.locator(':scope > summary').focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('link', { name: 'Overview' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('link', { name: 'Issues' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(menu.locator(':scope > summary')).toBeFocused();
});
