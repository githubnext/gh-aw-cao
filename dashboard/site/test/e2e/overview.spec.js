import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const dashboardDocument = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
const overviewPage = dashboardDocument.dashboard.pages.find((/** @type {{ id?: string }} */ page) => page.id === 'overview');
if (!overviewPage) throw new Error('The authoritative dashboard must declare the Overview page.');

const metadata = {
  'source-id': 'overview-parity-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-16T12:00:00Z',
  'retrieved-at': '2026-09-16T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

/** @param {string} name @param {Record<string, unknown>[]} rows */
function source(name, rows) {
  return { source: name, rows, metadata };
}

const sources = {
  'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2, 'delivered-repositories': 3 }]),
  'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 20, 'failed-runs': 2, 'active-runs': 4, 'active-live': 1, 'active-review': 3 }]),
  'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 12, 'failed-dispatches': 1 }]),
  'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
  'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
  'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is delivering value.' }]),
  'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 6 }]),
  'overview-worker-summary': source('overview-worker-summary', [{ workers: 3 }]),
  'overview-rhythm': source('overview-rhythm', [{
    rhythm: {
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
        label,
        date: `2026-09-${String(14 + index).padStart(2, '0')}`,
        current: index + 1,
        previous: 7 - index,
        reached: index < 3
      }))
    }
  }])
};

test.beforeEach(async ({ page, context }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (!existsSync(filePath)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
      body: readFileSync(filePath)
    });
  });
  await page.goto('http://dashboard.test/#page-overview');
});

test('refactored Overview matches the deployed composition on desktop and mobile', async ({ page }) => {
  const refactoredPage = structuredClone(overviewPage);
  const deployedPage = structuredClone(overviewPage);
  delete deployedPage.views[0].config.sections;

  /** @param {Record<string, unknown>} pageDefinition */
  const render = async (pageDefinition) => {
    await page.evaluate(async ({ documentModel, sourceData, presenterModuleUrl }) => {
      const { renderDashboard } = await import(presenterModuleUrl);
      document.querySelector('#root')?.replaceChildren(renderDashboard({
        document: documentModel,
        sources: sourceData
      }));
    }, {
      documentModel: {
        'language-version': dashboardDocument['language-version'],
        dashboard: {
          id: 'overview-parity',
          title: 'Overview parity',
          pages: [pageDefinition]
        }
      },
      sourceData: sources,
      presenterModuleUrl: 'http://dashboard.test/src/presenter.js'
    });
    const factory = page.locator('[data-page-id="overview"] .agent-factory');
    await expect(factory).toBeVisible();
    await expect(factory).toHaveAttribute('aria-labelledby', 'agent-factory-heading');
    await expect(factory.locator(':scope > .factory-intro + .factory-floor')).toHaveCount(1);
    await expect(factory.getByRole('heading', { name: 'Your factory is delivering value.' })).toBeVisible();
    await expect(factory.locator('.factory-running-active')).toHaveText('Work in motion');
    await expect(factory.locator('.factory-rhythm-day')).toHaveCount(7);
    await expect(factory.locator('.factory-rhythm-day small')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    await expect(factory.locator('.factory-station')).toHaveCount(4);
    await expect(factory.locator('.factory-station strong')).toHaveText(['6', '20', '12', '1']);
    await expect(factory.locator('.factory-station small')).toHaveText(['', '2 failed', '1 failed', '']);
    expect(await factory.locator('.factory-station strong a').evaluateAll((links) =>
      links.map((link) => link.getAttribute('href'))
    )).toEqual([
      '#page-repositories',
      '#page-runs?runs-runs-source.run-conclusion=success',
      '#page-runs',
      '#page-operational-value'
    ]);
    await expect(factory.getByRole('link', { name: '2 failed' })).toHaveAttribute('href', '#page-runs?runs-runs-source.run-conclusion=failure');
    await expect(factory.getByRole('link', { name: '1 failed' })).toHaveAttribute('href', '#page-dispatches?package-worker-dispatches.status=failure');
    return {
      markup: await factory.evaluate((element) => element.outerHTML),
      screenshot: await factory.screenshot({ animations: 'disabled' })
    };
  };

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const deployed = await render(deployedPage);
    const refactored = await render(refactoredPage);

    expect(refactored.markup).toBe(deployed.markup);
    expect(refactored.screenshot.equals(deployed.screenshot)).toBe(true);
    expect(await page.locator('.factory-intro').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.width <= 390 ? 1 : 2);
    expect(await page.locator('.factory-stations').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.width <= 390 ? 2 : 4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
