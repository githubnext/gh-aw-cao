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

test('explicit Overview composition preserves default desktop and mobile behavior', async ({ page }) => {
  const explicitPage = structuredClone(overviewPage);
  const defaultPage = structuredClone(overviewPage);
  explicitPage.views[0].config.sections = ['header', 'floor'];
  delete defaultPage.views[0].config.sections;

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
    return page.locator('[data-page-id="overview"] .agent-factory');
  };

  for (const viewport of [
    { width: 1440, height: 900, introColumns: 2, stationColumns: 4 },
    { width: 390, height: 844, introColumns: 1, stationColumns: 2 }
  ]) {
    await page.setViewportSize(viewport);
    const defaultFactory = await render(defaultPage);
    const defaultMarkup = await defaultFactory.evaluate((element) => element.outerHTML);
    const defaultBox = await defaultFactory.boundingBox();
    const factory = await render(explicitPage);

    await expect(factory).toBeVisible();
    await expect(factory).toHaveAttribute('aria-labelledby', 'agent-factory-heading');
    await expect(factory.locator(':scope > .factory-intro + .factory-floor')).toHaveCount(1);
    await expect(factory.getByRole('heading', { name: 'Your factory is delivering value.' })).toBeVisible();
    await expect(factory.locator('.factory-running-active')).toBeVisible();
    await expect(factory.locator('.factory-rhythm-day')).toHaveCount(7);
    await expect(factory.locator('.factory-station')).toHaveCount(4);
    expect(await factory.locator('.factory-station a').count()).toBeGreaterThan(0);
    expect(await page.locator('.factory-intro').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.introColumns);
    expect(await page.locator('.factory-stations').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.stationColumns);
    expect(await factory.evaluate((element) => element.outerHTML)).toBe(defaultMarkup);
    expect(await factory.boundingBox()).toEqual(defaultBox);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
