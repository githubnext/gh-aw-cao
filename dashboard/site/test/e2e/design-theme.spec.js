import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));

test.beforeEach(async ({ page, context }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return;
    }
    const path = join(siteRoot, pathname);
    if (!existsSync(path)) {
      await route.fulfill({ status: 404 });
      return;
    }
    const contentType = pathname.endsWith('.woff2') ? 'font/woff2'
      : pathname.endsWith('.json') ? 'application/json' : 'application/javascript';
    await route.fulfill({ contentType, body: readFileSync(path) });
  });
  await page.goto('http://dashboard.test/');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`docs typography and theme controls work at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(async (origin) => {
      const { renderDashboard } = await import(`${origin}/src/presenter.js`);
      const { renderThemeControl } = await import(`${origin}/src/components/theme-settings.js`);
      const root = renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'design-theme',
            title: 'Central Agentic Ops',
            pages: [{ id: 'overview', kind: 'custom', title: 'Overview', views: [], sections: [] }]
          }
        },
        sources: {}
      });
      root.append(renderThemeControl());
      document.querySelector('#root')?.append(root);
      await document.fonts.ready;
    }, 'http://dashboard.test');

    const root = page.locator('.dashboard-root');
    await expect(root).toHaveCSS('background-color', 'rgb(252, 252, 251)');
    await expect(root).toHaveCSS('font-family', /"CAO Sans"/);
    await expect(root).toHaveCSS('font-optical-sizing', 'auto');
    const fontLoaded = await page.evaluate(async () => {
      const normal = await document.fonts.load('400 14px "CAO Sans"');
      const italic = await document.fonts.load('italic 400 14px "CAO Sans"');
      return normal.length > 0 && italic.length > 0
        && [...normal, ...italic].every((font) => font.status === 'loaded');
    });
    expect(fontLoaded).toBe(true);

    const themes = root.getByRole('group', { name: 'Theme', exact: true });
    await themes.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(root).toHaveCSS('background-color', 'rgb(12, 10, 9)');
    await expect(themes.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.emulateMedia({ colorScheme: 'dark' });
    await themes.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(root).toHaveCSS('background-color', 'rgb(252, 252, 251)');
    await themes.getByRole('button', { name: 'System', exact: true }).click();
    await expect(root).not.toHaveAttribute('data-theme');
    await expect(root).toHaveCSS('background-color', 'rgb(12, 10, 9)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveCSS('background-color', 'rgb(252, 252, 251)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
