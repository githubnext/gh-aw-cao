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
  'database-campaign-count': source('database-campaign-count', [{ campaigns: 2 }]),
  'database-repository-count': source('database-repository-count', [{ repositories: 6 }]),
  'database-workflow-count': source('database-workflow-count', [{ workflows: 9 }]),
  'database-run-count': source('database-run-count', [{ runs: 20 }]),
  'database-domain-count': source('database-domain-count', [{ domains: 4 }]),
  'database-tool-count': source('database-tool-count', [{ tools: 12 }]),
  'database-audit-count': source('database-audit-count', [{ audits: 15 }]),
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
  ])
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

test('declarative Overview keeps only database counters on desktop and mobile', async ({ page }) => {
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
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const overview = await render(overviewPage);

    await expect(overview).toBeVisible();
    await expect(overview.locator(':scope > [data-view-id^="overview-"]')).toHaveCount(8);
    await expect(overview.locator('.factory-intro, .factory-rhythm, .factory-floor')).toHaveCount(0);
    const notifications = page.locator('[data-page-id="notifications"]');
    await expect(notifications).toHaveCount(0);
    await expect(notifications.locator('.entity-card-list-card')).toHaveCount(0);
    await expect(overview.locator('[data-metric-value="campaigns"]')).toHaveText('2');
    await expect(overview.locator('[data-metric-value="repositories"]')).toHaveText('6');
    await expect(overview.locator('[data-metric-value="workflows"]')).toHaveText('9');
    await expect(overview.locator('[data-metric-value="runs"]')).toHaveText('20');
    await expect(overview.locator('[data-metric-value="domains"]')).toHaveText('4');
    await expect(overview.locator('[data-metric-value="tools"]')).toHaveText('12');
    await expect(overview.locator('[data-metric-value="audits"]')).toHaveText('15');
    await expect(overview.locator('[data-metric-value="issues"]')).toHaveText('5');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test('renders an Overview loading state before counter data resolves', async ({ page }) => {
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
      pageSkeletons: overview?.querySelectorAll('.dashboard-view-skeleton').length,
      pageBusy: overview?.getAttribute('aria-busy')
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
    sourceLoadCalls: 0,
    pageLoadCalls: 1,
    pageSkeletons: 1,
    pageBusy: 'true'
  });
});
