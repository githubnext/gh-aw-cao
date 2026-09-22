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
  'overview-campaign-links': source('overview-campaign-links', [
    {
      campaign: 'aw-doctor',
      'campaign-name': 'AW Doctor',
      'campaign-icon': 'gear',
      'campaign-dashboard-link': {
        'dashboard-href': '#page-campaign-insights?campaign=aw-doctor',
        'dashboard-label': 'View AW Doctor campaign dashboard'
      }
    },
    {
      campaign: 'dependabot',
      'campaign-name': 'Dependabot',
      'campaign-icon': 'dependabot',
      'campaign-dashboard-link': {
        'dashboard-href': '#page-campaign-insights?campaign=dependabot',
        'dashboard-label': 'View Dependabot campaign dashboard'
      }
    }
  ]),
  'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2, 'delivered-repositories': 3 }]),
  'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 20, 'failed-runs': 2, 'active-runs': 4, 'active-live': 1, 'active-review': 3 }]),
  'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 12, 'failed-dispatches': 1 }]),
  'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
  'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
  'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is delivering value.' }]),
  'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 6 }]),
  'overview-worker-summary': source('overview-worker-summary', [{ workers: 3 }]),
  'database-campaign-count': source('database-campaign-count', [{ campaigns: 2 }]),
  'database-issue-count': source('database-issue-count', [{ issues: 5 }]),
  'overview-needs-attention-preview': source('overview-needs-attention-preview', [
    {
      kind: 'Repeated workflow failures',
      title: '.github/workflows/doctor.md',
      scope: 'githubnext/gh-aw-cao',
      reason: '2 failed runs in the selected horizon',
      'failure-count': 2,
      action: 'Open latest failed run on GitHub',
      'observed-at': '2026-09-16T11:30:00Z',
      'evidence-link': {
        href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42',
        label: 'View run 42'
      }
    },
    ...['101', '102'].map((id) => ({
      kind: 'Human review required',
      title: `Review output ${id}`,
      scope: 'githubnext/gh-aw-cao',
      reason: 'Output awaits approval',
      action: 'Open review item on GitHub',
      'observed-at': '2026-09-16T10:00:00Z',
      'evidence-link': {
        href: `https://github.com/githubnext/gh-aw-cao/issues/${id}`,
        label: `View issue ${id}`
      }
    }))
  ]),
  'campaign-inventory': source('campaign-inventory', [{
    campaign: 'aw-doctor',
    'campaign-name': 'AW Doctor',
    'campaign-dashboard-link': {
      'dashboard-href': '#page-campaign-insights?campaign=aw-doctor',
      'dashboard-label': 'View AW Doctor campaign dashboard'
    },
    workflows: 3,
    modes: ['review'],
    registration: ['active'],
    runs: 20,
    'value-created': 7,
    dispatches: 12,
    aic: 42
  }]),
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

test('declarative Overview views preserve desktop and mobile behavior', async ({ page }) => {
  /** @param {Record<string, unknown>} pageDefinition */
  const render = async (pageDefinition) => {
    await page.evaluate(async ({ documentModel, sourceData, presenterModuleUrl }) => {
      const { renderDashboard } = await import(presenterModuleUrl);
      const rendered = renderDashboard({
        document: documentModel,
        sources: sourceData
      });
      document.querySelector('#root')?.replaceChildren(rendered);
    }, {
      documentModel: {
        'language-version': dashboardDocument['language-version'],
        dashboard: {
          id: 'overview-parity',
          title: 'Overview parity',
          'card-templates': dashboardDocument.dashboard['card-templates'],
          pages: [pageDefinition]
        }
      },
      sourceData: sources,
      presenterModuleUrl: 'http://dashboard.test/src/presenter.js'
    });
    return page.locator('[data-page-id="overview"] > .custom-view-grid');
  };

  for (const viewport of [
    { width: 1440, height: 900, introColumns: 2, stationColumns: 6 },
    { width: 390, height: 844, introColumns: 1, stationColumns: 2 }
  ]) {
    await page.setViewportSize(viewport);
    const factory = await render(overviewPage);

    await expect(factory).toBeVisible();
    await expect(factory.locator(':scope > [data-view-id="overview-header"]')).toHaveClass(/factory-intro/);
    await expect(factory.locator(':scope > [data-view-id="overview-floor"]')).toHaveClass(/factory-floor/);
    const campaigns = factory.locator(':scope > [data-view-id="overview-campaigns"]');
    await expect(campaigns).toBeVisible();
    await expect(campaigns.locator('.link-button-list')).toBeVisible();
    await expect(campaigns.locator('.link-button-list-item')).toHaveCount(2);
    await expect(campaigns.getByRole('link', { name: 'View AW Doctor campaign dashboard' }))
      .toHaveAttribute('href', '#page-campaign-insights?campaign=aw-doctor');
    await expect(factory.locator(':scope > .factory-intro + .factory-floor')).toHaveCount(1);
    const notifications = page.locator('[data-page-id="notifications"]');
    await expect(notifications).toHaveCount(0);
    await expect(notifications.locator('.entity-card-list-card')).toHaveCount(0);
    await expect(factory.getByRole('heading', { name: 'Your factory is delivering value.' })).toBeVisible();
    await expect(factory.locator('.factory-running')).toHaveCount(0);
    await expect(factory.locator('.factory-rhythm-day')).toHaveCount(7);
    const rhythmBars = factory.locator('.factory-rhythm-bar-pair i:not([hidden])');
    await expect(rhythmBars.first()).toHaveCSS('animation-name', 'factory-rhythm-bar-grow');
    expect(await rhythmBars.last().evaluate((element) => getComputedStyle(element).animationDelay)).toBe('0.21s');
    await expect(factory.locator('.factory-station')).toHaveCount(6);
    await expect(factory.locator('.factory-station').nth(0)).toContainText('Campaigns2');
    await expect(factory.locator('.factory-station').nth(1)).toContainText('Repositories registered6');
    await expect(factory.locator('.factory-station').nth(2)).toContainText('Issues & PRs5');
    await expect(factory.locator('.factory-station').nth(0).locator('small')).toHaveText('');
    await expect(factory.locator('.factory-station').nth(2).locator('small')).toHaveText('');
    expect(await factory.locator('.factory-station a').count()).toBeGreaterThan(0);
    expect(await page.locator('.factory-intro').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.introColumns);
    expect(await page.locator('.factory-stations').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    )).toBe(viewport.stationColumns);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test('disables Overview rhythm animation when reduced motion is preferred', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async ({ documentModel, sourceData, presenterModuleUrl }) => {
    const { renderDashboard } = await import(presenterModuleUrl);
    const rendered = renderDashboard({ document: documentModel, sources: sourceData });
    document.querySelector('#root')?.replaceChildren(rendered);
  }, {
    documentModel: {
      'language-version': dashboardDocument['language-version'],
      dashboard: {
        id: 'overview-reduced-motion',
        title: 'Overview reduced motion',
        'card-templates': dashboardDocument.dashboard['card-templates'],
        pages: [overviewPage]
      }
    },
    sourceData: sources,
    presenterModuleUrl: 'http://dashboard.test/src/presenter.js'
  });

  await expect(page.locator('.factory-rhythm-bar-pair i:not([hidden])').first()).toHaveCSS('animation-name', 'none');
});

test('renders the Overview structure before mixed page data resolves', async ({ page }) => {
  const immediate = await page.evaluate(async ({ documentModel, presenterModuleUrl, sourceStoreModuleUrl }) => {
    const [{ renderDashboard }, { configureSourceLoader }] = await Promise.all([
      import(presenterModuleUrl),
      import(sourceStoreModuleUrl)
    ]);
    let sourceLoadCalls = 0;
    let pageLoadCalls = 0;
    configureSourceLoader(() => {
      sourceLoadCalls += 1;
      return new Promise(() => {});
    });
    const rendered = renderDashboard({
      document: documentModel,
      sources: {},
      loadPageSources: () => {
        pageLoadCalls += 1;
        return new Promise(() => {});
      }
    });
    document.querySelector('#root')?.replaceChildren(rendered);
    const overview = rendered.querySelector('[data-page-id="overview"]');
    return {
      sourceLoadCalls,
      pageLoadCalls,
      header: Boolean(overview?.querySelector(':scope > .custom-view-grid > .factory-intro')),
      floor: Boolean(overview?.querySelector(':scope > .custom-view-grid > .factory-floor')),
      pageSkeletons: overview?.querySelectorAll('.dashboard-view-skeleton').length,
      pageBusy: overview?.getAttribute('aria-busy'),
      headerBusy: overview?.querySelector('.factory-intro')?.getAttribute('aria-busy'),
      floorBusy: overview?.querySelector('.factory-floor')?.getAttribute('aria-busy'),
      campaigns: Boolean(overview?.querySelector('.link-button-list-view')),
      campaignsBusy: overview?.querySelector('.link-button-list-view')?.getAttribute('aria-busy'),
      headingPending: overview?.querySelectorAll('.factory-heading-pending').length,
      rhythmPending: overview?.querySelectorAll('.factory-rhythm-pending').length,
      stationsPending: overview?.querySelectorAll('.factory-station-pending').length
    };
  }, {
    documentModel: {
      'language-version': dashboardDocument['language-version'],
      dashboard: {
        id: 'overview-loading',
        title: 'Overview loading',
        pages: [overviewPage]
      }
    },
    presenterModuleUrl: 'http://dashboard.test/src/presenter.js',
    sourceStoreModuleUrl: 'http://dashboard.test/src/source-store.js'
  });

  expect(immediate).toEqual({
    sourceLoadCalls: 13,
    pageLoadCalls: 0,
    header: true,
    floor: true,
    campaigns: true,
    pageSkeletons: 0,
    pageBusy: null,
    headerBusy: null,
    floorBusy: null,
    campaignsBusy: '',
    headingPending: 1,
    rhythmPending: 1,
    stationsPending: 6
  });
});
