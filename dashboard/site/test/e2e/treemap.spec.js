import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import contract from '../fixtures/treemap-contract.json' with { type: 'json' };

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const now = new Date().toISOString();
const sources = {
  repositories: { rows: [{ organization: 'githubnext', repository: 'alpha' }, { organization: 'githubnext', repository: 'beta' }] },
  workflows: { rows: [
    { organization: 'githubnext', repository: 'alpha', workflow: '.github/workflows/doctor.md' },
    { organization: 'githubnext', repository: 'beta', workflow: '.github/workflows/audit.md' }
  ] },
  runs: { rows: Array.from({ length: 8 }, (_, index) => ({
    organization: 'githubnext', repository: index < 6 ? 'alpha' : 'beta',
    workflow: index < 6 ? '.github/workflows/doctor.md' : '.github/workflows/audit.md',
    run: String(index + 1), 'run-attempt': 1, 'run-status': 'completed',
    'run-conclusion': index < 6 ? 'success' : 'failure', 'started-at': now
  })) }
};

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    } else if (pathname === '/sources.json') {
      await route.fulfill({ json: Object.fromEntries(Object.entries(sources).map(([name, source]) => [
        name, { ...source, metadata: { 'as-of': now, 'artifact-generation': 'treemap-browser' } }
      ])) });
    } else if (existsSync(join(siteRoot, pathname))) {
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(join(siteRoot, pathname))
      });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://dashboard.test/');
});

for (const theme of ['light', 'dark']) {
  for (const width of [1280, 390]) {
    test(`worker-backed treemap remains readable and contained at ${width}px in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const counts = await page.evaluate(async ({ document: fixture, theme, moduleUrls }) => {
        const [{ loadCanonicalDashboardSources }, { renderDashboard }] = await Promise.all([
          import(moduleUrls[0]), import(moduleUrls[1])
        ]);
        const result = await loadCanonicalDashboardSources(
          'http://dashboard.test/sources.json', ['workflow-footprint'],
          { pages: fixture.dashboard.pages, queries: fixture.dashboard.queries },
          undefined, { pageId: 'footprint' }
        );
        const root = renderDashboard({
          document: { languageVersion: fixture['language-version'], dashboard: fixture.dashboard }, sources: result
        });
        root.dataset.theme = theme;
        document.querySelector('#root')?.append(root);
        return Object.values(result).flatMap((source) => source.rows).map((row) => row['run-count']);
      }, { document: contract, theme, moduleUrls: [
        'http://dashboard.test/src/data-processor.js', 'http://dashboard.test/src/presenter.js'
      ] });
      expect(counts).toEqual([6, 2]);
      const plot = page.locator('.treemap-plot');
      await expect(plot).toBeVisible();
      await expect(page.locator('[data-treemap-leaf]')).toHaveCount(2);
      await expect(page.locator('[data-treemap-group]')).toHaveCount(2);
      const leaves = page.locator('[data-treemap-leaf]');
      const tooltipId = await leaves.nth(0).getAttribute('aria-describedby');
      const tooltip = page.locator(`[id="${tooltipId}"]`);
      await leaves.nth(0).hover();
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText('doctor.md');
      await expect(tooltip).toContainText('alpha');
      await expect(tooltip).toContainText('Runs: 6');
      await expect(tooltip).toContainText('success');
      const tooltipBox = await tooltip.boundingBox();
      if (!tooltipBox) throw new Error('Expected visible tooltip geometry');
      expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(width);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.mouse.move(0, 0);
      await leaves.nth(0).focus();
      await expect(leaves.nth(0)).toBeFocused();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(tooltip).not.toBeVisible();
      await page.keyboard.press('Tab');
      await expect(leaves.nth(1)).toBeFocused();
      await leaves.nth(0).click();
      await expect(tooltip).toBeVisible();
      await expect(leaves.nth(0)).toHaveAttribute('aria-label', 'alpha / doctor.md: Runs 6; success');
      const plotBox = await plot.boundingBox();
      expect(plotBox).not.toBeNull();
      if (!plotBox) throw new Error('Expected treemap layout');
      expect(plotBox.x).toBeGreaterThanOrEqual(0);
      expect(plotBox.x + plotBox.width).toBeLessThanOrEqual(width);
      for (const leaf of await leaves.all()) {
        const box = await leaf.boundingBox();
        if (!box) throw new Error('Expected visible leaf geometry');
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(plotBox.x);
        expect(box.y).toBeGreaterThanOrEqual(plotBox.y);
        expect(box.x + box.width).toBeLessThanOrEqual(plotBox.x + plotBox.width + 0.1);
        expect(box.y + box.height).toBeLessThanOrEqual(plotBox.y + plotBox.height + 0.1);
      }
    });
  }
}
