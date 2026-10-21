import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

test('execution repository management stacks filter accessibly in the full site on desktop and mobile', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const preview = await startDashboardServer({
    workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
    repository: 'octo/control', port: 0,
    output: () => {}, requestOutput: () => {}, traceOutput: () => {},
    downloadData: async (/** @type {string} */ destination) => {
      const now = new Date().toISOString();
      const metadata = { 'as-of': now, availability: 'available', completeness: 'complete', freshness: 'fresh' };
      const identity = { organization: 'octo', repository: 'control' };
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'sources.json'), JSON.stringify({
        repositories: { metadata, rows: [
          { ...identity, 'repository-link': { href: 'https://github.com/octo/control', relation: 'repository' } },
          { organization: 'octo', repository: 'idle' }
        ] },
        workflows: { metadata, rows: [
          { ...identity, workflow: 'central.md', 'workflow-name': 'Central standalone', 'workflow-role': 'standalone', 'inventory-ready': false },
          { ...identity, workflow: 'local.md', 'workflow-name': 'Local workflow', 'workflow-role': 'standalone', 'workflow-registry-state': 'active' }
        ] },
        runs: { metadata, rows: ['central.md', 'local.md', 'unknown.md'].map((workflow, index) => ({
          ...identity, workflow, run: String(index + 1), 'run-attempt': 1,
          'started-at': now, 'run-status': 'completed', 'run-conclusion': 'success'
        })) }
      }));
    }
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${preview.url}/#page-repositories`);
    const chart = page.locator('[data-view-id="repositories-runs"]');
    await expect(chart.getByRole('heading', { name: 'Runs by execution repository', exact: true })).toBeVisible();
    const total = chart.getByRole('img', {
      name: 'octo/control: 3 (Centrally managed: 1; Repository-owned: 1; Unclassified: 1)', exact: true
    });
    await expect(total).toBeVisible();
    await expect(chart.locator('.horizontal-bar-chart-row')).toHaveCount(2);
    await expect(chart.locator('a[href="#page-repository-detail?repository=octo%2Fcontrol"]').first()).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect(total).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const screenshot = testInfo.outputPath(`repository-management-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`repository-management-${width}`, { path: screenshot, contentType: 'image/png' });
      const management = chart.locator('summary');
      await management.focus();
      await management.press('Enter');
      await chart.getByRole('checkbox', { name: 'Repository-owned', exact: true }).check();
      await chart.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect(chart.getByRole('img', { name: 'octo/control: 1, Repository-owned', exact: true })).toBeVisible();
      await expect(chart.locator('.horizontal-bar-chart-row')).toHaveCount(1);
      await chart.locator('summary').click();
      await expect(chart.getByRole('checkbox', { name: 'Centrally managed', exact: true })).toBeVisible();
      await expect(chart.getByRole('checkbox', { name: 'Unclassified', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(chart.locator('summary')).toBeFocused();
      await chart.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await expect(total).toBeVisible();
    }
  } finally {
    await preview.close();
  }
});
