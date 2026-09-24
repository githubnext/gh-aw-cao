import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, devices } from '@playwright/test';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const authoritativeDashboard = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ page, context }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return;
    }

    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath);
      const mime = pathname.endsWith('.json')
        ? 'application/json'
        : pathname.endsWith('.svg')
          ? 'image/svg+xml'
          : 'application/javascript';
      await route.fulfill({ contentType: mime, body: content });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://dashboard.test/');
});

function buildPresenterModuleUrl() {
  return 'http://dashboard.test/src/presenter.js';
}

test('campaign problem detail renders a responsive full view without a table', async ({ page }) => {
  await page.evaluate(async ({ problemUrl, stylesUrl }) => {
    const [{ renderProblemDetail }, { primerStylesheet }] = await Promise.all([
      import(problemUrl),
      import(stylesUrl)
    ]);
    const style = document.createElement('style');
    style.textContent = primerStylesheet();
    document.head.append(style);
    const metadata = {
      'source-id': 'campaign-problem-items-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-24T18:00:00Z',
      'retrieved-at': '2026-09-24T18:00:00Z',
      completeness: 'complete',
      freshness: 'fresh',
      availability: 'available'
    };
    const rendered = renderProblemDetail({
      pageId: 'campaign-problem-detail',
      title: 'Problem',
      sourceNames: ['campaign-problem-items'],
      contextDetails: [],
      routeParameter: 'target-repository',
      headingTag: 'h3',
      sources: {
        'campaign-problem-items': {
          source: 'campaign-problem-items',
          metadata,
          rows: [{
            campaign: 'dependabot',
            'campaign-name': 'Dependabot',
            workflow: '.github/workflows/dependabot.md',
            'workflow-name': 'Dependabot / Update Planner',
            'workflow-role': 'orchestrator',
            'runtime-repository': 'github/gh-aw',
            'target-repository': 'github/gh-aw',
            'rollout-mode': 'live',
            'problem-kind': 'failure',
            'problem-title': 'Dependency update failed',
            'failure-count': 4,
            'occurrence-count': 65,
            'failure-message': 'The dependency update command exited with status 1.',
            'error-signature': 'dependency-update-failed',
            'failure-job': 'update',
            'failure-step': 'Apply update',
            'gh-aw-version': '0.89.20',
            engine: 'copilot',
            'engine-version': '1.2.3',
            'requested-model': 'model-a',
            'resolved-model': 'model-b',
            'started-at': '2026-09-24T10:00:00Z',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/github/gh-aw/actions/runs/1',
              label: 'View run'
            }
          }]
        }
      }
    });
    document.querySelector('#root')?.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
  }, {
    problemUrl: 'http://dashboard.test/src/components/problem-detail.js',
    stylesUrl: 'http://dashboard.test/src/styles.js'
  });

  const problemDetail = page.locator('.problem-view');
  await expect(problemDetail).toBeVisible();
  await expect(problemDetail.locator('table')).toHaveCount(0);
  await expect(problemDetail.getByRole('heading', { name: 'Failure' })).toBeVisible();
  await expect(problemDetail.getByRole('heading', { name: 'Scope' })).toBeVisible();
  await expect(problemDetail.getByRole('heading', { name: 'Runtime environment' })).toBeVisible();
  await expect(problemDetail.getByRole('button', { name: 'Fix It' })).toBeVisible();
  await expect(problemDetail.getByRole('link', { name: 'View run' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.setViewportSize({ width: 500, height: 800 });
  await expect(problemDetail.locator('.problem-view-sections')).toHaveCSS('grid-template-columns', '500px');
});

for (const deviceName of ['Desktop Chrome', 'iPhone 13', 'Pixel 7']) {
  test.describe(`GitHub navigation on ${deviceName}`, () => {
    const device = devices[deviceName];
    test.use({ userAgent: device.userAgent, isMobile: device.isMobile, hasTouch: device.hasTouch });

    test('preserves deep links and browser fallback using native anchor navigation', async ({ page, context }) => {
      const href = 'https://github.com/octo-org/platform/pull/42?diff=split#discussion_r123';
      await context.route('https://github.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<h1>GitHub browser fallback</h1>'
      }));
      await page.evaluate(async (href) => {
        const { renderExternalLink } = await import(new URL('/src/components/link-content.js', window.location.href).href);
        document.querySelector('#root')?.append(
          renderExternalLink({ href, label: 'Review pull request' }),
          renderExternalLink({ href: '#page-runs', label: 'Dashboard runs' })
        );
      }, href);

      const link = page.getByRole('link', { name: 'Review pull request' });
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('target', device.isMobile ? '_self' : '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      await page.getByRole('link', { name: 'Dashboard runs' }).click();
      await expect(page).toHaveURL('http://dashboard.test/#page-runs');

      await link.focus();
      if (device.isMobile) {
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(href);
        await expect(page.getByRole('heading', { name: 'GitHub browser fallback' })).toBeVisible();
        expect(context.pages()).toHaveLength(1);
      } else {
        const popupPromise = page.waitForEvent('popup');
        await page.keyboard.press('Enter');
        const popup = await popupPromise;
        await expect(popup).toHaveURL(href);
        await expect(page).toHaveURL('http://dashboard.test/#page-runs');
        await popup.close();
      }
    });
  });
}

test('shows a not-supported message instead of starting without IndexedDB', async ({ page }) => {
  await page.evaluate(async (mainModuleUrl) => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    await import(mainModuleUrl);
  }, 'http://dashboard.test/src/main.js');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Browser not supported');
  await expect(alert).toContainText('This dashboard requires IndexedDB');
});

test('initializes IndexedDB during dashboard startup', async ({ page }) => {
  await page.evaluate(async (databaseName) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Unable to clear IndexedDB before startup.'));
    });
    await import(new URL('/src/main.js', window.location.href).href);
  }, DATABASE_NAME);

  await expect.poll(() => page.evaluate(async (databaseName) => (
    (await indexedDB.databases()).some(({ name }) => name === databaseName)
  ), DATABASE_NAME)).toBe(true);
});

/**
 * @param {string} pageId
 * @param {Record<string, unknown>} [overrides]
 */
function builtInPage(pageId, overrides = {}) {
  const template = authoritativeDashboard.dashboard.pages.find((/** @type {{ kind?: string, page?: string }} */ page) => (
    page.kind === 'built-in' && page.page === pageId
  ));
  assert(template, `Missing built-in page template for ${pageId}`);
  return {
    ...template,
    ...overrides,
    definition: template.definition,
  };
}


test('ingestion notifications reveal scrollable progress history on click', async ({ page }) => {
  await page.setContent(`
    <main style="height: 2000px"></main>
    <script type="module">
      import { publishNotification } from 'http://dashboard.test/src/notification-service.js';
      const ingestionNotification = publishNotification({
        message: '750 KB/1.5 MB · 3s remaining',
        icon: 'download',
        duration: 0,
        details: Array.from({ length: 40 }, (_, index) => 'Activity event ' + (index + 1))
      });
      window.addEventListener('update-ingestion-notification', (event) => {
        ingestionNotification.update(event.detail);
      });
    </script>
  `);

  const toggle = page.getByRole('button', { name: /750 KB\/1.5 MB.*Show ingestion progress history/ });
  const details = page.locator('.dashboard-notification-details');
  await expect(toggle.locator('.octicon-download')).toBeVisible();
  await expect(details).toBeHidden();
  await toggle.click();
  const collapse = page.getByRole('button', { name: /750 KB\/1.5 MB.*Hide ingestion progress history/ });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toBeVisible();
  await expect(details.getByRole('listitem')).toHaveCount(40);
  expect(await details.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(details).toHaveCSS('list-style-type', 'none');
  await page.evaluate(() => window.scrollTo(0, 100));
  await details.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(100);
  await details.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await details.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(100);
  const previousScrollTop = await details.evaluate((element) => element.scrollTop);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('update-ingestion-notification', {
      detail: {
        message: 'Refreshing queries...',
        duration: 0,
        details: Array.from({ length: 41 }, (_, index) => 'Activity event ' + (index + 1))
      }
    }));
  });
  await expect(details.getByRole('listitem')).toHaveCount(41);
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(previousScrollTop);

  await details.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('update-ingestion-notification', {
      detail: {
        message: 'Still refreshing...',
        duration: 0,
        details: Array.from({ length: 42 }, (_, index) => 'Activity event ' + (index + 1))
      }
    }));
  });
  await expect(details).toHaveJSProperty('scrollTop', 0);
  await page.locator('.dashboard-notification-toggle').click();
  await expect(details).toBeHidden();
});

test('Settings disables hourly dashboard downloads when unsupported', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderConfigurationView } from 'http://dashboard.test/src/components/configuration-view.js';
      const metadata = {
        'source-id': 'configuration-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-12T00:00:00Z',
        'retrieved-at': '2026-09-12T00:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      document.querySelector('#root').append(renderConfigurationView({
        pageId: 'configuration',
        title: 'Settings',
        description: 'Dashboard settings.',
        sourceNames: ['configuration-policy'],
        sources: {
          'configuration-policy': {
            source: 'configuration-policy',
            rows: [{ document: { version: 1 }, raw: '', diagnostics: [] }],
            metadata
          }
        },
        contextDetails: [],
        headingTag: 'h3'
      }));
    </script>
  `);

  const checkbox = page.getByRole('checkbox', { name: 'Download updated data every hour' });
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeDisabled();
  await expect(page.locator('#configuration-automatic-dashboard-data-updates-status'))
    .toContainText('Periodic Background Sync is not supported');
  await expect(page.getByRole('heading', { name: 'Debugging' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Relaunch with debugging' }))
    .toHaveAttribute('href', 'http://dashboard.test/?debug=1');
  await expect(page.getByRole('button', { name: 'Copy console logs' })).toBeVisible();
});

test('production Settings view loads without an unsupported-view warning', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'configuration-integration-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-12T00:00:00Z',
        'retrieved-at': '2026-09-12T00:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        'configuration-policy': {
          source: 'configuration-policy',
          rows: [{
            path: '.github/workflows/cao.json',
            document: { version: 1 },
            raw: '{"version":1}',
            diagnostics: []
          }],
          metadata
        }
      };
      window.location.hash = '#page-configuration';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const settingsPage = page.locator('[data-page-id="configuration"]');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(settingsPage.locator('.configuration-view')).toBeVisible();
  await expect(settingsPage.locator('[data-theme-value]')).toHaveCount(0);
  await expect(settingsPage.getByRole('button', { name: 'Copy updated JSON' })).toBeVisible();
  await expect(settingsPage).not.toContainText('Unsupported view mark.');
  await expect(settingsPage).not.toContainText('Unsupported UI element.');
});

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance
 */
function expectLayoutWithin(actual, expected, tolerance) {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

/**
 * Full-view table filters live inside the table scroller but remain contained
 * within the visible viewport instead of owning a separate horizontal scrollbar;
 * wrapping is allowed on narrow screens so controls stay reachable.
 * @param {import('@playwright/test').Locator} tableFilter The `.table-scroll > .table-filter` element.
 */
async function expectTableFilterIsContained(tableFilter) {
  await expect.poll(async () => tableFilter.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

/**
 * Lazy-list windows move one page at a time when the user reaches the top edge;
 * each step must keep compact full-view mode active and keep the rendered
 * two-page, 50-row window intact.
 * @param {import('@playwright/test').Locator} scroll Table scroll region to move to the top edge.
 * @param {import('@playwright/test').Locator} view Full-view table view containing the rendered lazy rows.
 * @param {import('@playwright/test').Locator} root Dashboard root expected to remain in compact full-view mode.
 * @param {string} expectedFirstRowText Text fragment expected in the first rendered row after the paging step.
 */
async function pageUpAndExpectCompactWindow(scroll, view, root, expectedFirstRowText) {
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(view.locator('tbody > tr').first()).toContainText(expectedFirstRowText);
  await expect(root).toHaveClass(/dashboard-full-view-scrolled/);
  await expect(view.locator('tbody > tr')).toHaveCount(50);
}

test('dashboard lazy views preload within the scroller margin and survive scroll jumps', async ({ page }) => {
  await page.setContent(`
    <style>
      main.dashboard-prototype { height: 300px; overflow-y: auto; }
      .dashboard-lazy-view { min-height: var(--dashboard-lazy-view-min-height); }
      .spacer { height: 500px; }
    </style>
    <main class="dashboard-prototype">
      <section id="lazy-root"><div class="spacer"></div></section>
    </main>
    <script type="module">
      import { enableLazyViews, renderLazyView } from ${JSON.stringify('http://dashboard.test/src/components/lazy-view.js')};
      const root = document.querySelector('#lazy-root');
      const panel = (id) => renderLazyView({
        label: id,
        minHeight: 240,
        render: () => {
          const article = document.createElement('article');
          article.dataset.hydratedPanel = id;
          article.style.height = '240px';
          return article;
        }
      });
      root.append(panel('near'), Object.assign(document.createElement('div'), { className: 'spacer' }), panel('skipped'), Object.assign(document.createElement('div'), { className: 'spacer' }));
      enableLazyViews(root);
    </script>
  `);

  await expect(page.locator('[data-hydrated-panel="near"]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Loading skipped' })).toHaveCount(1);

  await page.locator('main.dashboard-prototype').evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(page.locator('[data-hydrated-panel="skipped"]')).toHaveCount(1);
});

/** @param {import('@playwright/test').Page} page @param {string} title */
async function hydrateView(page, title) {
  const placeholder = page.getByRole('region', { name: `Loading ${title}` });
  if (await placeholder.count() === 0) return;
  await placeholder.first().scrollIntoViewIfNeeded().catch(() => {});
  await expect(placeholder).toHaveCount(0);
}

test('mobile shell keeps Overview navigation in the hamburger menu', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = ${JSON.stringify(documentModel)};
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources: {} }));
    </script>
  `);

  const primaryNav = page.locator('.primary-nav');
  const overviewAction = page.locator('[data-nav-page-id="overview"]');
  const dashboardMain = page.locator('main.dashboard-prototype');
  const factoryOverview = page.locator('[data-page-id="overview"] > .custom-view-grid');
  await expect(primaryNav).toBeHidden();
  await expect(overviewAction).toBeHidden();
  const viewportSize = page.viewportSize();
  expect(viewportSize).not.toBeNull();
  if (viewportSize === null) throw new Error('Expected Playwright to provide a viewport size');
  const viewportWidth = viewportSize.width;
  await expect(factoryOverview).toBeVisible();
  const layoutPixelTolerance = 1;
  const [mainBox, factoryBox] = await Promise.all([
    dashboardMain.boundingBox(),
    factoryOverview.boundingBox()
  ]);
  expect(mainBox).not.toBeNull();
  expect(factoryBox).not.toBeNull();
  if (mainBox === null || factoryBox === null) throw new Error('Expected overview layout boxes to be available');
  expectLayoutWithin(factoryBox.x, 0, layoutPixelTolerance);
  expectLayoutWithin(factoryBox.y, mainBox.y, layoutPixelTolerance);
  expectLayoutWithin(factoryBox.width, viewportWidth, layoutPixelTolerance);

  const headerCopy = factoryOverview.locator('.factory-intro-copy');
  const rhythm = factoryOverview.locator('.factory-rhythm');
  const stations = factoryOverview.locator('.factory-station');
  const [headerCopyBox, rhythmBox, firstStationBox, secondStationBox] = await Promise.all([
    headerCopy.boundingBox(),
    rhythm.boundingBox(),
    stations.nth(0).boundingBox(),
    stations.nth(1).boundingBox()
  ]);
  if (!headerCopyBox || !rhythmBox || !firstStationBox || !secondStationBox) {
    throw new Error('Expected responsive Overview component boxes to be available');
  }
  expect(rhythmBox.y).toBeGreaterThanOrEqual(headerCopyBox.y + headerCopyBox.height);
  expect(await factoryOverview.locator('.factory-stations').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
  )).toBe(2);
  expect(firstStationBox.x).toBeLessThan(secondStationBox.x);
  expectLayoutWithin(firstStationBox.y, secondStationBox.y, 8);
  await expect(factoryOverview.locator('.factory-rhythm-day')).toHaveCount(7);

  await page.locator('.mobile-nav-menu > summary').click();
  await page.locator('[data-mobile-nav-page-id="runs"]').click();

  await expect(primaryNav).toHaveCSS('display', 'none');
  await expect(page.locator('[data-mobile-nav-page-id="overview"]')).toHaveAttribute('href', '#page-overview');
});



test('Transactions is a responsive table of retained transaction data', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const rows = Array.from({ length: 100 }, (_, index) => ({
        id: \`transaction:\${index}\`,
        kind: index % 2 === 0 ? 'ingest-jsonl' : 'ingest-dashboard-sources',
        createdAt: new Date(Date.UTC(2026, 8, 12, 12, index)).toISOString(),
        payloadScope: \`https://dashboard.example/gh-aw-logs-shards/logs-\${index}.jsonl\`,
        payloadHash: \`sha256:\${index}\`,
        payloadEtag: \`etag-\${index}\`,
        records: 30 + index,
        committedRecords: 25 + index,
        rawPayloadRecords: 24 + index,
        rawRuns: 20 + index,
        agenticRunRecords: 10 + index,
        agenticRuns: 8 + index,
        duplicateRawRunObservations: index,
        duplicateAgenticRunObservations: index,
        unenrichedRuns: index,
        error: ''
      }));
      const metadata = {
        'source-id': 'transactions-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-12T12:00:00Z',
        'retrieved-at': '2026-09-12T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        transactions: { source: 'transactions', rows, metadata },
        'configuration-policy': {
          source: 'configuration-policy',
          rows: [{ document: { version: 1 }, raw: '{"version":1}', diagnostics: [] }],
          metadata
        },
        'database-campaign-count': { source: 'database-campaign-count', rows: [{ campaigns: 2 }], metadata },
        'overview-healthy-campaign-count': { source: 'overview-healthy-campaign-count', rows: [{ 'healthy-campaigns': 1 }], metadata },
        'overview-repository-coverage': { source: 'overview-repository-coverage', rows: [{ 'repository-coverage': 0.5, 'reached-repositories': 3, 'registered-repositories-total': 6 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 3 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 5 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 8 }], metadata },
        'database-domain-count': { source: 'database-domain-count', rows: [{ domains: 7 }], metadata },
        'database-tool-count': { source: 'database-tool-count', rows: [{ tools: 11 }], metadata },
        'database-audit-count': { source: 'database-audit-count', rows: [{ audits: 13 }], metadata },
        'database-issue-count': { source: 'database-issue-count', rows: [{ issues: 17 }], metadata }
      };
      window.location.hash = '#page-overview';
      document.querySelector('#root').append(renderDashboard({ document: ${JSON.stringify(documentModel)}, sources }));
    </script>
  `);

  const dataNavigation = page.locator('.nav-section').filter({ hasText: 'Data' });
  await expect(dataNavigation.getByRole('link', { name: 'Transactions' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'View retained transactions table' }).click();

  const root = page.locator('.dashboard-root');
  const transactionsPage = page.locator('[data-page-id="transactions"]');
  const view = transactionsPage.locator('[data-view-layout="full-view"]');
  const scroll = view.locator('.table-scroll');
  await expect(transactionsPage.locator('[data-view-id]')).toHaveCount(1);
  await expect(transactionsPage.getByRole('heading', { name: 'Local database' })).toHaveCount(0);
  await expect(root).toHaveClass(/dashboard-full-view/);
  await expect(transactionsPage.locator('.line-chart-series')).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(view.locator('[data-lazy-list]')).toHaveCount(1);
  await expect(view.getByRole('searchbox', { name: 'Filter Transactions' })).toBeVisible();
  await expect(view.getByRole('cell', { name: 'ingest-jsonl' }).first()).toBeVisible();
  const headings = await view.locator('thead tr').first().getByRole('columnheader').allTextContents();
  expect(headings.at(-1)?.trim()).toBe('Created');
  expect(headings).toEqual(expect.arrayContaining([
    'Committed records',
    'Records',
    'Raw payload records',
    'Transaction',
    'Payload hash',
    'Payload ETag'
  ]));
  const scope = view.getByRole('link', { name: 'https://dashboard.example/.../logs-99.jsonl' }).first();
  await expect(scope).toHaveAttribute('href', 'https://dashboard.example/gh-aw-logs-shards/logs-99.jsonl');
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);

  await scroll.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(root).toHaveClass(/dashboard-full-view-scrolled/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(root).not.toHaveClass(/dashboard-full-view-scrolled/);
  await expect(page.locator('.org-sidebar')).toBeVisible();
  await expect(transactionsPage.locator(':scope > .page-chrome > .filter-bar')).toBeHidden();
  await expect(view).toBeVisible();
  await expect(root).toHaveClass(/dashboard-full-view/);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  await expect.poll(async () => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(async () => scroll.locator(':scope > .table-filter').evaluate(
    (element) => element.scrollWidth <= element.clientWidth
  )).toBe(true);

  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(root).not.toHaveClass(/dashboard-full-view-scrolled/);
  await expect(page.locator('.org-sidebar')).toBeVisible();
  await expect(page.locator('.top-nav')).toBeHidden();
});

test('Runs renders a last-week stacked area graph above its responsive table and scrolls like Cost', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'runs-viewport-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-10T12:00:00Z',
        'retrieved-at': '2026-09-10T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        'runs-daily-conclusions': {
          source: 'runs-daily-conclusions',
          metadata,
          rows: [
            { day: '2026-09-10', 'run-conclusion': 'failure', runs: 50 },
            { day: '2026-09-10', 'run-conclusion': 'success', runs: 50 }
          ]
        },
        'runs-table': {
          source: 'runs-table',
          metadata,
          rows: [
            {
              run: '2',
              'run-status': 'completed',
              'run-conclusion': 'failure',
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              'repository-coordinate': 'githubnext/gh-aw-cao',
              workflow: '.github/workflows/aw-doctor.md',
              'rollout-mode': 'review',
              engine: 'copilot',
              'engine-version': '1.2.3',
              'requested-model': 'gpt-5',
              'resolved-model': 'gpt-5',
              'started-at': '2026-09-10T12:00:00Z',
              'repository-link': { relation: 'repository', href: 'https://github.com/githubnext/gh-aw-cao', label: 'Open githubnext/gh-aw-cao' },
              'workflow-link': { relation: 'workflow', href: 'https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/aw-doctor.md', label: 'Open .github/workflows/aw-doctor.md' },
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/2', label: 'Run 2' }
            },
            {
              run: '1',
              'run-status': 'completed',
              'run-conclusion': 'success',
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              'repository-coordinate': 'githubnext/gh-aw-cao',
              workflow: '.github/workflows/aw-doctor.md',
              'rollout-mode': 'review',
              engine: 'copilot',
              'engine-version': '1.2.3',
              'requested-model': 'gpt-5',
              'resolved-model': 'gpt-5',
              'started-at': '2026-09-10T11:00:00Z',
              'repository-link': { relation: 'repository', href: 'https://github.com/githubnext/gh-aw-cao', label: 'Open githubnext/gh-aw-cao' },
              'workflow-link': { relation: 'workflow', href: 'https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/aw-doctor.md', label: 'Open .github/workflows/aw-doctor.md' },
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/1', label: 'Run 1' }
            }
          ]
        }
      };
      for (let run = 3; run <= 100; run += 1) {
        const template = sources['runs-table'].rows[run % 2];
        sources['runs-table'].rows.push({
          ...template,
          run: String(run),
          'run-link': {
            relation: 'run',
            href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/' + run,
            label: 'Run ' + run
          }
        });
      }
      window.location.hash = '#page-runs';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const dashboardRoot = page.locator('.dashboard-root');
  const runsPage = page.locator('[data-page-id="runs"]');
  const view = runsPage.locator('[data-view-layout="full-view"]');
  const table = view.locator('[data-lazy-list]');
  const scroll = view.locator('.table-scroll');
  const areaGraph = runsPage.locator('[data-view-id="runs-last-week"]');
  const columnHeaders = view.locator('thead > tr:first-child > th');
  const facetControl = columnHeaders.locator('.filter-select-control').first();
  const expectAlignedColumnHeaders = async () => {
    const headerTops = await columnHeaders.evaluateAll((headers) => headers.map((header) => header.getBoundingClientRect().top));
    expect(Math.max(...headerTops) - Math.min(...headerTops)).toBeLessThanOrEqual(1);
  };
  await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
  await expect(page.locator('[data-nav-page-id="runs"]')).toHaveAttribute('aria-current', 'page');
  await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view/);
  await expect(view).toHaveCount(1);
  await expect(areaGraph.locator('[data-chart-widget="area"]')).toBeVisible();
  await expect(areaGraph.locator('.area-chart-area')).toHaveCount(2);
  await expect(areaGraph.locator('.chart-legend-area')).toContainText('failure');
  await expect(areaGraph.locator('.chart-legend-area')).toContainText('success');
  await expect(areaGraph.locator('.line-chart-y-axis text')).toHaveText(['100', '50', '0']);
  const areaGraphHeadingBox = await areaGraph.getByRole('heading', { name: 'Runs in the last week' }).boundingBox();
  const areaGraphChartBox = await areaGraph.locator('[data-chart-widget="area"] svg').boundingBox();
  if (areaGraphHeadingBox === null || areaGraphChartBox === null) {
    throw new Error('Expected area graph heading and chart boxes to be measurable.');
  }
  expect(areaGraphChartBox.width).toBeGreaterThan(0);
  expect(areaGraphChartBox.height).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(table).toBeVisible();
  await expect(table.locator('tbody > tr')).toHaveCount(25);
  const more = table.locator('[data-table-more]');
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    await more.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  }
  await expect(table.locator('tbody > tr')).toHaveCount(50);
  await expect(view.locator('[data-table-filter]')).toBeVisible();
  const summaryRow = view.locator('.table-summary-row');
  const summaryToggle = summaryRow.getByRole('button', { name: 'Collapse column summaries' });
  await expect(summaryRow).toBeVisible();
  const expandedHeight = await summaryRow.evaluate((element) => element.getBoundingClientRect().height);
  await summaryToggle.click();
  await expect(summaryRow).toHaveClass(/table-summary-collapsed/);
  await expect(summaryRow.locator('.table-summary-expanded').first()).toBeHidden();
  await expect(summaryRow.locator('.table-summary-compact:visible').first()).toBeVisible();
  expect(await summaryRow.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(expandedHeight);
  await summaryRow.getByRole('button', { name: 'Expand column summaries' }).click();
  await expect(summaryRow).not.toHaveClass(/table-summary-collapsed/);
  await expect(view.locator('.custom-table tbody tr')).not.toHaveCount(0);
  await expect(view.locator('.custom-table tbody tr').first()).toContainText('2');
  await expectAlignedColumnHeaders();
  await scroll.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view-scrolled/);
  const facetControlBox = await facetControl.boundingBox();
  const scrolledSummaryBox = await summaryRow.boundingBox();
  assert(facetControlBox);
  assert(scrolledSummaryBox);
  expect(scrolledSummaryBox.y - (facetControlBox.y + facetControlBox.height)).toBeGreaterThanOrEqual(4);
  await page.getByRole('button', { name: 'Cards' }).click();
  await page.getByRole('button', { name: 'Chart' }).click();
  await expect(areaGraph).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileViewModeToggle = page.locator('.mobile-view-mode-toggle');
  await expect(runsPage.locator(':scope > .page-chrome > .filter-bar')).toBeHidden();
  await expect(areaGraph).toBeVisible();
  await expect(table).toBeHidden();
  await expect(mobileViewModeToggle).toHaveAttribute('aria-label', 'Switch to Cards view');
  await mobileViewModeToggle.click();
  await mobileViewModeToggle.click();
  await expect(areaGraph).toBeHidden();
  await expect(table).toBeVisible();
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view/);
  await expectAlignedColumnHeaders();
  await expect.poll(async () => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(async () => scroll.locator(':scope > .table-filter').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('a page combining a chart with a full-view table fills and scrolls in table and card layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'models-scroll',
          title: 'Models & Agents',
          pages: [{
            id: 'engines-models',
            kind: 'custom',
            title: 'Models & Agents',
            views: [{
              id: 'engines-models-distribution',
              title: 'Agent and model distribution',
              data: { source: 'engines-models-chart' },
              mark: 'chart',
              chart: 'pie',
              layout: 'full',
              encoding: {
                x: { field: 'summary', type: 'nominal', title: 'Agent / model' },
                y: { field: 'events', type: 'quantitative', title: 'Events' }
              }
            }, {
              id: 'engines-models-usage',
              title: 'Engines and models',
              data: { source: 'engines-models-usage' },
              mark: 'table',
              controls: 'interactive',
              layout: 'full-view',
              encoding: {
                columns: [
                  { field: 'summary', type: 'nominal', title: 'Agent / model' },
                  { field: 'events', type: 'quantitative', title: 'Events' }
                ]
              },
              'lazy-list': true
            }]
          }],
          navigation: [{ label: 'Data', pages: ['engines-models'] }]
        }
      };
      const metadata = {
        'source-id': 'models-scroll-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-15T12:00:00Z',
        'retrieved-at': '2026-09-15T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const chartRows = Array.from({ length: 6 }, (_, index) => ({
        summary: 'copilot / model-' + (index + 1),
        events: 6 - index
      }));
      const tableRows = Array.from({ length: 60 }, (_, index) => ({
        summary: 'copilot / model-' + (index + 1),
        events: 60 - index
      }));
      const sources = {
        'engines-models-chart': { source: 'engines-models-chart', rows: chartRows, metadata },
        'engines-models-usage': { source: 'engines-models-usage', rows: tableRows, metadata }
      };
      document.querySelector('#root').append(renderDashboard({
        document: dashboardDocument,
        sources
      }));
    </script>
  `);

  const dashboardRoot = page.locator('.dashboard-root');
  const chart = page.locator('[data-view-id="engines-models-distribution"]');
  const view = page.locator('[data-view-id="engines-models-usage"]');
  const scroll = view.locator('.table-scroll');
  const cards = view.locator('[data-mobile-card-list]');
  const cardScroll = cards.locator('.mobile-table-card-list-items');
  await expect(chart.locator('[data-chart-widget="pie"]')).toBeVisible();
  await expect(page.locator('.org-sidebar')).toBeVisible();
  await expect(scroll).toBeHidden();
  await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view/);

  await page.getByRole('button', { name: 'Table' }).click();
  await expect(chart).toBeHidden();
  await expect(scroll).toBeVisible();
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view/);
  await expect(page.locator('.org-sidebar')).toBeVisible();
  await expect.poll(async () => scroll.evaluate((element) => ({
    fillsView: Math.abs(innerHeight - element.getBoundingClientRect().bottom) <= 1,
    scrollable: element.scrollHeight > element.clientHeight
  }))).toEqual({ fillsView: true, scrollable: true });
  await scroll.evaluate((element) => { element.scrollTop = 100; });
  await expect.poll(async () => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Cards' }).click();
  await expect(chart).toBeHidden();
  await expect(scroll).toBeHidden();
  await expect(cards).toBeVisible();
  await expect(cards.locator('.entity-card-list-card').first()).toBeVisible();
  await expect(cards.locator('.entity-card-list-card').first()).toContainText('copilot / model-1');
  await expect(cards.getByRole('button', { name: 'Load more cards' })).toHaveCount(0);
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view/);
  await expect(page.getByRole('heading', { name: 'Engines and models', level: 3 })).toBeHidden();
  await expect.poll(async () => cards.evaluate((element) =>
    Math.abs(innerHeight - element.getBoundingClientRect().bottom) <= 1
  )).toBe(true);
  await expect.poll(async () => cardScroll.evaluate((element) =>
    element.scrollHeight > element.clientHeight
  )).toBe(true);
  await cardScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => cardScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(cards.locator('.entity-card-list-card')).toHaveCount(50);

  await page.getByRole('button', { name: 'Chart' }).click();
  await expect(chart).toBeVisible();
  await expect(scroll).toBeHidden();
  await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view/);
});

test('Runs renders the worker-projected table for an active time window', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      const documentModel = ${JSON.stringify(documentModel)};
      // Simulate an operator who narrowed the global horizon control to a
      // window that predates every recorded run, the same way "Last 1 hour"
      // (or a stale persisted setting) would hide 700+ real runs.
      window.localStorage.setItem(
        'central-agentic-ops.dashboard.horizon-filter-settings',
        JSON.stringify({ range: 'custom', start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z' })
      );
      const metadata = {
        'source-id': 'runs-empty-time-filter-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-10T12:00:00Z',
        'retrieved-at': '2026-09-10T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        runs: {
          source: 'runs',
          metadata,
          rows: [
            {
              run: '2',
              'run-status': 'completed',
              'run-conclusion': 'failure',
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/aw-doctor.md',
              'rollout-mode': 'review',
              engine: 'copilot',
              'engine-version': '1.2.3',
              'requested-model': 'gpt-5',
              'resolved-model': 'gpt-5',
              'started-at': '2026-09-10T12:00:00Z',
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/2', label: 'Run 2' }
            }
          ]
        }
      };
      window.location.hash = '#page-runs';
      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        documentModel,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      const viewSources = await loadPageSources('runs', {
        queryContext: { timeWindow: { start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z' } }
      });
      document.querySelector('#root').append(renderDashboard({
        document: documentModel,
        sources: viewSources,
        loadPageSources
      }));
    </script>
  `);

  const runsPage = page.locator('[data-page-id="runs"]');
  const view = runsPage.locator('[data-view-layout="full-view"]');
  const rows = view.locator('.custom-table tbody tr');
  // The shared time-window select lives once in the top-nav filter bar
  // (relocated there for the active page), not nested inside the page section.
  const horizonFilter = page.getByLabel('Dashboard filters');
  const select = horizonFilter.locator('[aria-label="Time window"]');

  await expect(select).toHaveValue('custom');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('No runs observed.');
  await view.getByRole('button', { name: 'Clear time filter' }).click();
  await expect(rows.first()).toContainText('2');
  await expect(rows.locator('a').first()).toBeVisible();
});

test('Issues switches between its top-repository chart, table, and cards', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'issues-page-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-20T12:00:00Z',
        'retrieved-at': '2026-09-20T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const issue = (id, repository, summary, observedAt) => ({
        id,
        organization: 'githubnext',
        repository,
        workflow: '.github/workflows/worker.md',
        run: id,
        'run-attempt': 1,
        event: id,
        'event-type': 'safe_output.created',
        'event-summary': summary,
        'event-timestamp': observedAt,
        'safe-output-type': 'create_issue',
        'github-entity-type': 'issue',
        'is-pull-request': false,
        'correlation-id': 'https://github.com/githubnext/' + repository + '/issues/' + id
      });
      const issues = [
        issue('3', 'alpha', 'Alpha issue 2', '2026-09-20T12:00:00Z'),
        issue('2', 'beta', 'Beta issue', '2026-09-19T12:00:00Z'),
        issue('1', 'alpha', 'Alpha issue 1', '2026-09-18T12:00:00Z')
      ];
      const sources = {
        audits: { source: 'audits', metadata, rows: [] },
        issues: { source: 'issues', metadata, rows: issues },
        runs: {
          source: 'runs',
          metadata,
          rows: issues.map((row) => ({
            organization: row.organization,
            repository: row.repository,
            workflow: row.workflow,
            run: row.run,
            'run-attempt': row['run-attempt'],
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/' + row.repository + '/actions/runs/' + row.run,
              label: 'Run ' + row.run
            }
          }))
        }
      };
      window.location.hash = '#page-issues';
      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        documentModel,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      const viewSources = await loadPageSources('issues', {});
      document.querySelector('#root').append(renderDashboard({
        document: documentModel,
        sources: viewSources,
        loadPageSources
      }));
    </script>
  `);

  const issuesPage = page.locator('[data-page-id="issues"]');
  const chart = issuesPage.locator('[data-view-id="issues-by-repository"]');
  const table = issuesPage.locator('[data-view-id="issues-source"] .table-region');
  const cards = issuesPage.locator('[data-mobile-card-list]');

  await expect(chart.locator('[data-chart-widget="pie"]')).toBeVisible();
  await expect(chart).toContainText('githubnext/alpha');
  await expect(page.getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Table' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').first()).toContainText('Alpha issue 2');

  await page.getByRole('button', { name: 'Cards' }).click();
  await expect(cards.locator('.entity-card-list-card')).toHaveCount(3);
  await expect(cards.locator('.entity-card-list-card').first()).toContainText('Alpha issue 2');
  await expect(cards.locator('.entity-card-list-card').first().locator('[data-card-drill="external"]')).toHaveAttribute(
    'href',
    'https://github.com/githubnext/alpha/issues/3'
  );
});





test('desktop navigation sections collapse and expand around the current view', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'section-navigation-dashboard',
            title: 'Section Navigation',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] }
            ],
            navigation: [
              { label: 'Main', pages: ['overview'] },
              { label: 'Investigate', pages: ['runs'] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `);

  const mainSection = page.locator('.nav-section').filter({ hasText: 'Main' });
  const investigateSection = page.locator('.nav-section').filter({ hasText: 'Investigate' });
  await expect(mainSection).toHaveAttribute('open', '');
  await expect(investigateSection).toHaveAttribute('open', '');

  await expect(investigateSection.getByRole('link', { name: 'Runs' })).toBeVisible();
  await investigateSection.getByRole('link', { name: 'Runs' }).click();
  await expect(investigateSection).toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
});

test('clean navigation preserves the Overview decision hierarchy across desktop and mobile', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      import { dashboardViewAliasName } from 'http://dashboard.test/src/data/queries/view-payload-compiler.js';
      import { configureSourceLoader } from 'http://dashboard.test/src/source-store.js';
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'dashboard-next-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T10:00:00Z',
        'retrieved-at': '2026-08-29T10:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const evidenceLink = {
        relation: 'evidence',
        href: 'https://example.com/evidence/release-train',
        label: 'Review dependency evidence'
      };
      const sources = {
        campaigns: { source: 'campaigns', rows: [{ id: 'campaign-1' }, { id: 'campaign-2' }], metadata },
        issues: {
          source: 'issues',
          rows: Array.from({ length: 17 }, (_, index) => ({ id: \`issue-\${index + 1}\` })),
          metadata
        },
        'configuration-policy': {
          source: 'configuration-policy',
          rows: [{ document: { version: 1 }, raw: '', diagnostics: [] }],
          metadata
        },
        'database-campaign-count': { source: 'database-campaign-count', rows: [{ campaigns: 2 }], metadata },
        'overview-healthy-campaign-count': { source: 'overview-healthy-campaign-count', rows: [{ 'healthy-campaigns': 1 }], metadata },
        'overview-repository-coverage': { source: 'overview-repository-coverage', rows: [{ 'repository-coverage': 0.5, 'reached-repositories': 3, 'registered-repositories-total': 6 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 3 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 5 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 8 }], metadata },
        'database-domain-count': { source: 'database-domain-count', rows: [{ domains: 7 }], metadata },
        'database-tool-count': { source: 'database-tool-count', rows: [{ tools: 11 }], metadata },
        'database-audit-count': { source: 'database-audit-count', rows: [{ audits: 13 }], metadata },
        'database-issue-count': { source: 'database-issue-count', rows: [{ issues: 17 }], metadata },
        'overview-failed-run-count': {
          source: 'overview-failed-run-count',
          rows: [{ count: 80 }],
          metadata
        },
        'overview-blocked-work-count': {
          source: 'overview-blocked-work-count',
          rows: [],
          metadata: { ...metadata, availability: 'unavailable' }
        },
        'overview-awaiting-review-count': {
          source: 'overview-awaiting-review-count',
          rows: [],
          metadata: { ...metadata, availability: 'unavailable' }
        },
        'overview-security-finding-count': {
          source: 'overview-security-finding-count',
          rows: [],
          metadata: { ...metadata, availability: 'unavailable' }
        },
        'work-items': {
          source: 'work-items',
          rows: [
            {
              'work-item-id': 'dependabot:github/gh-aw:release-train',
              objective: 'Update the Dependabot release train',
              scope: 'github/gh-aw',
              'lifecycle-state': 'review',
              phase: 'verifying',
              reason: 'Security review remains pending.',
              'next-action': 'Review the dependency update evidence',
              'waiting-on': 'security-reviewers',
              owner: 'dependency-automation',
              'started-at': '2026-08-29T08:00:00Z',
              'ended-at': '2026-08-29T12:00:00Z',
              'evidence-link': evidenceLink
            },
            {
              'work-item-id': 'aw-doctor:github/gh-aw:inventory',
              objective: 'Inspect workflow inventory',
              scope: 'github/gh-aw',
              'lifecycle-state': 'unknown',
              phase: 'unknown',
              reason: 'Run telemetry is incomplete.',
              'next-action': 'Collect run telemetry',
              owner: 'aw-doctor',
              'started-at': '2026-08-01T08:00:00Z'
            }
          ],
          metadata
        },
        'attention-signals': {
          source: 'attention-signals',
          rows: [
            {
              'attention-signal-id': 'verification:dependabot:74',
              'signal-type': 'verification-review',
              objective: 'Update the Dependabot release train',
              scope: 'github/gh-aw',
              reason: 'Security verification requires human review.',
              action: 'Review dependency evidence',
              'expected-actor': 'security-reviewers',
              'age-seconds': 4800,
              'consequence-tier': 'high',
              priority: 2,
              'evidence-link': evidenceLink
            },
            {
              'attention-signal-id': 'authority:mona-tools:upgrade',
              'signal-type': 'authority-gate',
              objective: 'Upgrade agentic workflow dependencies',
              scope: 'github/mona-tools',
              reason: 'Live target authority is unavailable.',
              action: 'Confirm authority or retain review mode',
              'expected-actor': 'repository-owner',
              'age-seconds': 9000,
              'consequence-tier': 'medium',
              priority: 1,
              'evidence-link': evidenceLink
            }
          ],
          metadata
        },
        'agent-assignments': {
          source: 'agent-assignments',
          rows: [{
            'assignment-id': 'assignment:update-planner:74',
            'agent-name': 'Dependabot update planner',
            'agent-state': 'waiting',
            objective: 'Update the Dependabot release train',
            'handoff-state': 'waiting-for-review',
            'dependency-state': 'clear',
            'conflict-state': 'none',
            'evidence-link': evidenceLink
          }],
          metadata
        },
        'evidence-records': {
          source: 'evidence-records',
          rows: [{
            'evidence-id': 'evidence:dependabot:74:checks',
            objective: 'Update the Dependabot release train',
            'evidence-kind': 'verification',
            'evidence-class': 'observed',
            claim: 'Three required validations passed.',
            'verification-state': 'pending',
            'provenance-state': 'complete',
            'observed-at': '2026-08-29T09:55:00Z',
            'evidence-link': evidenceLink
          }],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              'safe-output': 'dependabot-review',
              'safe-output-kind': 'create-issue',
              'outcome-category': 'issue',
              'outcome-title': 'Dependabot review retained',
              repository: 'gh-aw',
              'outcome-state': 'accepted',
              'observed-at': '2026-08-29T09:40:00Z',
              'external-link': evidenceLink
            },
            {
              'safe-output': 'dependabot-update',
              'safe-output-kind': 'create-pull-request',
              'outcome-category': 'pull-request',
              'outcome-title': 'Dependabot update retained',
              repository: 'gh-aw',
              'outcome-state': 'accepted',
              'observed-at': '2026-08-29T09:45:00Z',
              'external-link': evidenceLink
            }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            ...Array.from({ length: 80 }, (_, index) => ({
              repository: 'gh-aw', workflow: 'review', run: String(index + 1),
              'run-status': 'completed', 'run-conclusion': 'failure', 'started-at': '2026-08-29T09:30:00Z'
            })),
            ...Array.from({ length: 20 }, (_, index) => ({
              repository: 'gh-aw', workflow: 'update', run: String(index + 81),
              event: index < 12 ? 'workflow_dispatch' : 'schedule',
              'run-status': 'completed', 'run-conclusion': 'success', 'started-at': '2026-08-29T09:35:00Z'
            })),
            {
              repository: 'gh-aw', workflow: 'dispatch', run: '101',
              'run-status': 'in-progress', 'run-conclusion': 'unknown', 'started-at': '2026-08-29T09:50:00Z'
            }
          ],
          metadata
        },
        repositories: {
          source: 'repositories',
          rows: [{ id: 'repository:github/gh-aw', repository: 'gh-aw', 'rollout-mode': 'review', 'observed-at': '2026-08-29T09:30:00Z' }],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { repository: 'gh-aw', workflow: 'dispatch', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'observed-at': '2026-08-29T09:30:00Z' },
            { repository: 'gh-aw', workflow: 'review', 'workflow-role': 'worker', 'workflow-active': 'true', 'observed-at': '2026-08-29T09:30:00Z' },
            { repository: 'gh-aw', workflow: 'update', 'workflow-role': 'worker', 'workflow-active': 'true', 'observed-at': '2026-08-29T09:30:00Z' }
          ],
          metadata
        },
        'safe-output-performance': {
          source: 'safe-output-performance',
          rows: [{ 'safe-output-count': 1, 'observed-at': '2026-08-29T09:40:00Z' }],
          metadata
        },
        'operational-graders': {
          source: 'operational-graders',
          rows: [
            {
              'operational-grader': 0.6,
              'operational-grader-definition': 'accepted-outcome',
              'observed-at': '2026-08-01T09:45:00Z',
              'evidence-link': evidenceLink
            },
            {
              'operational-grader': 0.8,
              'operational-grader-definition': 'accepted-outcome',
              'observed-at': '2026-08-29T09:45:00Z',
              'evidence-link': evidenceLink
            }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [
            {
              repository: 'gh-aw',
              aic: 8,
              'observed-at': '2026-08-01T09:50:00Z'
            },
            {
              repository: 'gh-aw',
              aic: 12,
              'observed-at': '2026-08-29T09:50:00Z'
            }
          ],
          metadata
        },
        'github-api-rate-limits': {
          source: 'github-api-rate-limits',
          rows: [{
            credential: 'control-plane',
            resource: 'core',
            remaining: 4200,
            'remaining-percent': 84,
            'reset-at': '2026-08-29T11:00:00Z',
            'risk-status': 'healthy'
          }],
          metadata
        }
      };
      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        documentModel,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      configureSourceLoader(async (name, options) => {
        const prepared = await prepareDashboardViewSources(
          documentModel,
          options?.pageId ?? 'overview',
          sources,
          { queryContext: options?.queryContext }
        );
        const alias = options?.pageId && options.viewId
          ? dashboardViewAliasName(
              options.pageId,
              { id: options.viewId },
              0,
              name,
              options.sourceIndex ?? 0
            )
          : name;
        return prepared[alias] ?? prepared[name];
      });
      document.querySelector('#root').append(renderDashboard({
        document: documentModel,
        sources,
        loadPageSources
      }));
    </script>
  `);

  const cleanNavigation = page.locator('.primary-nav > [data-nav-page-id]');
  const data = page.locator('.nav-section').filter({ hasText: 'Data' });
  const manage = page.locator('.nav-section').filter({ hasText: 'Manage' });
  await expect(cleanNavigation).toHaveText(['Overview']);
  await expect(data.locator('summary')).toHaveText('Data');
  await data.locator('summary').click();
  await expect(data.getByRole('link')).toHaveText(['Campaigns', 'Repositories', 'Workflows', 'Runs', 'Issues', 'Models & Agents', 'Firewall', 'MCPs']);
  await expect(manage.locator('summary')).toHaveText('Manage');
  await expect(manage.getByRole('link')).toHaveText(['Maintenance', 'Settings']);
  await expect(manage).toHaveClass(/nav-section-bottom/);
  await expect.poll(async () => {
    const [navBox, manageBox] = await Promise.all([
      page.locator('.primary-nav').boundingBox(),
      manage.boundingBox()
    ]);
    return navBox !== null && manageBox !== null
      ? Math.round(navBox.y + navBox.height - (manageBox.y + manageBox.height))
      : null;
  }).toBeLessThanOrEqual(1);
  await expect(page.locator('.nav-section').filter({ hasText: 'Experimental' })).toHaveCount(0);
  await expect(cleanNavigation.first().locator('.octicon-home')).toBeVisible();
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.refresh-button')).toHaveCount(0);
  const themeControl = page.locator('.top-nav .theme-control');
  await expect(themeControl).toBeVisible();
  await expect(themeControl.locator('summary')).toHaveAccessibleName('Appearance');
  expect(await themeControl.evaluate((element) => element.nextElementSibling?.classList.contains('repository-link'))).toBe(true);
  await themeControl.locator('summary').click();
  await expect(themeControl.locator('#dashboard-appearance-heading')).toBeVisible();
  await expect(themeControl.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dashboard-root')).not.toHaveAttribute('data-theme');
  await themeControl.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('.dashboard-root')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('central-agentic-ops.dashboard.theme'))).toBe('light');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#page-configuration$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('[data-page-id="configuration"] [data-theme-value]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset local data' }).click();
  const resetDialog = page.getByRole('dialog', { name: 'Reset dashboard confirmation' });
  await expect(resetDialog).toBeVisible();
  await expect(resetDialog).toContainText('This action cannot be undone.');
  await resetDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(resetDialog).not.toBeVisible();
  await page.getByRole('link', { name: 'View retained transactions table' }).click();
  await expect(page).toHaveURL(/#page-transactions$/);
  await page.getByRole('link', { name: 'Settings' }).click();
  const description = page.locator('.overview-header .lede');
  expect(await description.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  await expect(page.getByText('Dashboard Next', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Show experimental')).toHaveCount(0);

  await cleanNavigation.filter({ hasText: 'Overview' }).click();
  const overviewPage = page.locator('[data-page-id="overview"]');
  await expect(overviewPage.locator(':scope > .custom-view-grid')).toBeVisible();
  await expect(overviewPage.getByRole('heading', { name: 'Your campaigns are humming.' })).toBeVisible();
  await expect(overviewPage.locator('.factory-running')).toHaveCount(0);
  await expect(overviewPage.locator('.factory-station')).toHaveCount(2);
  await expect(overviewPage.locator('.factory-station strong')).toHaveText(['100%', '0%']);
  await expect(overviewPage.locator('.factory-station small')).toHaveText(['2/2 healthy campaigns', '0/1 repositories reached']);
  await expect(overviewPage.locator('.factory-output')).toHaveCount(0);
  await expect(overviewPage.locator('.factory-status')).toHaveCount(0);
  await expect(overviewPage.locator('.notifications-inbox')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const factoryLinks = overviewPage.locator('.factory-station a');
  expect(await factoryLinks.count()).toBeGreaterThan(0);
  for (const link of await factoryLinks.evaluateAll((links) => links.map((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { text: element.textContent?.trim(), width, height };
  }))) {
    expect(link.width, `${link.text} link width`).toBeGreaterThanOrEqual(24);
    expect(link.height, `${link.text} link height`).toBeGreaterThanOrEqual(24);
  }
  await page.evaluate(() => { window.location.hash = '#page-overview-failed-runs'; });
  const failedRunsPage = page.locator('[data-page-id="overview-failed-runs"]');
  await expect(failedRunsPage).toBeVisible();
  await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
  await expect(failedRunsPage.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => innerHeight));
  const fullViewShellSize = await page.locator('.top-nav > .shell').evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Overview' }).click();
  await expect(overviewPage).toBeVisible();

  for (const pageId of ['overview-blocked-work', 'overview-security-findings']) {
    await page.evaluate((nextPageId) => { window.location.hash = `#page-${nextPageId}`; }, pageId);
    const attentionPage = page.locator(`[data-page-id="${pageId}"]`);
    await expect(attentionPage).toBeVisible();
    await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
    await expect(attentionPage.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  }
  await page.evaluate(() => { window.location.hash = '#page-overview'; });
  await expect(overviewPage).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#page-overview-awaiting-review'; });
  const reviewPage = page.locator('[data-page-id="overview-awaiting-review"]');
  await expect(reviewPage).toBeVisible();
  await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
  await expect(reviewPage.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  expect(await page.locator('.top-nav > .shell').evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  })).toEqual(fullViewShellSize);
  await expect(reviewPage.locator('.custom-view')).toHaveCount(1);
  await expect(reviewPage.locator('.table-summary-row .table-summary-cell')).toHaveCount(3);
  await expect(reviewPage.locator('tbody tr')).toHaveCount(1);
  await expect(reviewPage.locator('tbody a[href="https://example.com/evidence/release-train"]')).toBeVisible();
  await expect(page.locator('[data-breadcrumb-dashboard]')).toHaveText('Overview');
  await cleanNavigation.filter({ hasText: 'Overview' }).click();
  await expect(overviewPage).toBeVisible();

  // A 320px window can leave 305px of layout width when the browser reserves a scrollbar gutter.
  await page.setViewportSize({ width: 305, height: 844 });
  await page.evaluate(() => { window.location.hash = '#page-overview'; });
  await expect(overviewPage).toBeVisible();
  await expect(overviewPage.locator(':scope > .custom-view-grid')).toBeVisible();
  await expect(overviewPage.locator('.factory-station')).toHaveCount(2);
  await page.locator('.mobile-nav-menu > summary').click();
  await expect(page.locator('.mobile-nav-section-label')).toHaveText(['Data', 'Manage']);
  await expect(page.locator('[data-mobile-nav-page-id="operations"]')).toHaveCount(0);
  await page.locator('.mobile-nav-menu > summary').click();
  await expect(overviewPage.locator('.factory-intro')).toBeInViewport();
  await expect(overviewPage.locator('.custom-view')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(overviewPage.locator('.table-scroll')).toHaveCount(0);

  for (const pageName of ['overview']) {
    await page.evaluate((nextPage) => { window.location.hash = `#page-${nextPage}`; }, pageName);
    const activePage = page.locator(`[data-page-id="${pageName}"]`);
    await expect(activePage).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const chart of await activePage.locator('[data-chart-widget]').all()) {
      const box = await chart.boundingBox();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
    }
  }
});




test('histogram keeps a low constant DOM size for 100,000 observations', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderChartWidget } from ${JSON.stringify('http://dashboard.test/src/components/chart-elements.js')};
      const points = Array.from({ length: 100_000 }, (_, index) => ({
        x: String(index),
        y: index,
        color: null
      }));
      document.querySelector('#root').append(renderChartWidget('histogram', points, []));
    </script>
  `);

  const histogram = page.locator('[data-chart-widget="histogram"]');
  await expect(histogram).toBeVisible();
  await expect(histogram.locator('.histogram-chart-bar')).toHaveCount(18);
  expect(await histogram.locator('*').count()).toBeLessThan(150);
});

test('DLS-DOC-014 horizon details are available in the expanded window picker', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'horizon-dashboard',
          title: 'Horizon dashboard',
          horizon: {
            label: 'Horizon',
            tooltip: {
              label: 'Horizon details',
              description: 'Data is included from the start up to the exclusive end.',
              icon: 'question'
            }
          },
          defaults: { time: { range: '1w' } },
          pages: [{ id: 'runs', kind: 'built-in', page: 'runs', title: 'Runs' }]
        }
      };
      const sources = {
        runs: {
          source: 'runs',
          rows: [{ run: '1', 'observed-at': '2026-09-01T11:00:00Z' }],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'retrieved-at': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const trigger = page.getByRole('button', { name: /Horizon 1 week/ });
  const details = page.getByRole('group', { name: 'Horizon details' });
  await expect(page.getByRole('button', { name: 'Horizon details', exact: true })).toHaveCount(0);
  await expect(details).toBeHidden();
  await trigger.click();
  await expect(details).toBeVisible();
  await expect(details).toContainText('StartAug 25, 2026, 12:00 PM UTC');
  await expect(details).toContainText('EndSep 1, 2026, 12:00 PM UTC');
  await expect(details).toContainText('Duration1 week');

  await page.setViewportSize({ width: 393, height: 852 });
  await page.locator('.mobile-nav-menu > summary').click();
  await expect(details).toBeHidden();
  await trigger.click();
  await expect(details).toBeVisible();
  await expect(page.locator('.report-footer .refresh-button')).toHaveCount(0);
  const actionBoxes = await page.locator('.report-actions > *').evaluateAll((items) => items.map((item) => {
    const bounds = item.getBoundingClientRect();
    return { top: Math.round(bounds.top), left: bounds.left, right: bounds.right };
  }));
  const actionTops = new Set(actionBoxes.map((box) => box.top));
  expect(actionTops.size).toBe(actionBoxes.length);
  for (const box of actionBoxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(393);
  }
  const detailsBox = await details.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox?.x).toBeGreaterThanOrEqual(0);
  expect((detailsBox?.x ?? 0) + (detailsBox?.width ?? 0)).toBeLessThanOrEqual(393);
});


test('JSON full-view mode fills the viewport and supports repeated lazy-list scrolling', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 1000, height: 900 });

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const metadata = {
        'source-id': 'repositories-layout-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-01T03:00:00Z',
        'retrieved-at': '2026-09-01T03:01:00Z',
        'coverage-start': '2026-08-31T03:00:00Z',
        'coverage-end': '2026-09-01T03:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const emptySource = (source) => ({ source, rows: [], metadata });
      const campaigns = ['EU CRA', 'Repository Ops', 'Optimization'];
      const roles = ['orchestrator', 'worker'];
      const modes = ['review', 'live', 'staged'];
      const sources = {
        inventory: {
          source: 'inventory',
          rows: Array.from({ length: 100 }, (_, index) => ({
            organization: 'githubnext',
            repository: \`repository-\${index + 1}\`,
            campaign: campaigns[index % campaigns.length],
            role: roles[index % roles.length],
            mode: modes[index % modes.length]
          })),
          metadata
        },
        runs: emptySource('runs')
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'full-view-layout',
          title: 'Full View Layout',
          callouts: [{
            id: 'inventory-warning',
            title: 'Inventory warning',
            description: 'Inventory data may be incomplete.'
          }],
          pages: [{
            id: 'inventory',
            kind: 'custom',
            title: 'Inventory',
            description: 'Inventory subtitle',
            views: [{
              id: 'inventory-callout',
              title: 'Review inventory warning',
              description: 'Some inventory rows require review.',
              mark: 'callout',
              callout: {
                label: 'Warning',
                icon: 'alert'
              }
            }, {
               id: 'inventory-summary',
               title: 'Inventory summary',
               data: { source: 'inventory' },
               mark: 'metric',
               encoding: {
                 value: { field: 'repository', type: 'nominal', aggregate: 'distinct-count' }
               }
             }, {
               id: 'inventory-list',
               title: 'Inventory list',
               description: 'Inventory view subtitle',
              data: { source: 'inventory' },
              mark: 'table',
              controls: 'interactive',
              'lazy-list': true,
              layout: 'full-view',
              encoding: {
                columns: [
                  { field: 'organization', type: 'nominal' },
                  { field: 'repository', type: 'nominal' },
                  { field: 'campaign', type: 'nominal' },
                  { field: 'role', type: 'nominal' },
                  { field: 'mode', type: 'nominal' }
                ]
              }
            }]
          }],
          navigation: [{ label: 'Explore', pages: ['inventory'] }]
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const view = page.locator('[data-view-layout="full-view"]');
  const siteCallout = page.getByRole('status', { name: 'Inventory warning' });
  const warningCallout = page.getByRole('note', { name: 'Review inventory warning' });
  const summary = page.locator('[data-view-id="inventory-summary"]');
  const pageTitle = page.locator('#page-title');
  const tableFilter = view.locator('.table-filter');
  const lazyList = view.locator('[data-lazy-list]');
  const dashboardRoot = page.locator('.dashboard-root');
  const fieldName = view.locator('thead > tr:first-child > th').first();
  const summaryCell = view.locator('.table-summary-row > th').first();
  await expect(view).toHaveCount(1);
  await expect(siteCallout).toBeVisible();
  await expect(warningCallout).toBeVisible();
  await expect(summary).toBeVisible();
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(warningCallout).toBeHidden();
  await expect(summary).toBeHidden();
  await expect(pageTitle).toBeVisible();
  await expect(tableFilter).toBeVisible();
  await expect(lazyList).toHaveCount(1);
  await expect(view.getByRole('searchbox', { name: 'Filter Inventory list' })).toBeVisible();
  await expect(page.locator('.overview-header .lede')).toBeHidden();
  await expect(view.getByRole('heading', { name: 'Inventory list' })).toBeHidden();
  expect(await lazyList.evaluate((element) => getComputedStyle(element).borderWidth)).toBe('0px');
  expect((await lazyList.boundingBox())?.height).toBeGreaterThanOrEqual(550);
  await expect(view.locator('tbody tr:visible')).toHaveCount(25);

  const scroll = view.locator('.table-scroll');
  await expect(scroll).toHaveCSS('overscroll-behavior-x', 'none');
  const more = view.locator('[data-table-more]');
  const sidebarBox = await page.locator('.org-sidebar').boundingBox();
  const initialScrollBox = await scroll.boundingBox();
  assert(sidebarBox);
  assert(initialScrollBox);
  expect(initialScrollBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
  await more.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await expect(view.locator('tbody > tr')).toHaveCount(50);
  await more.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await more.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await expect(view.locator('tbody > tr')).toHaveCount(50);
  await expect(view.locator('tbody > tr').first()).toContainText('repository-51');

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await scroll.evaluate((element) => {
      element.scrollTop = 100;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(dashboardRoot).toHaveClass(/dashboard-full-view-scrolled/);
    await expect(siteCallout).toBeHidden();
    await expect(warningCallout).toBeHidden();
    await expect(summary).toBeHidden();
    await expect(pageTitle).toBeHidden();
    await expect(fieldName).toHaveCSS('opacity', '0.8');
    await expect(summaryCell).toHaveCSS('opacity', '0');
    await expect(summaryCell).toHaveCSS('transition-property', 'opacity');
    const expandedScrollBox = await scroll.boundingBox();
    assert(expandedScrollBox);
    expect(expandedScrollBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    expect(expandedScrollBox.width).toBeCloseTo(initialScrollBox.width, 0);
    expect((await lazyList.boundingBox())?.height).toBeGreaterThanOrEqual(830);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(view.locator('tbody > tr').first()).toContainText('repository-51');
    await pageUpAndExpectCompactWindow(scroll, view, dashboardRoot, 'repository-26');
    await pageUpAndExpectCompactWindow(scroll, view, dashboardRoot, 'repository-1');
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view-scrolled/);
    await expect(pageTitle).toBeVisible();
    await expect(tableFilter).toBeVisible();
    await expect(summaryCell).toHaveCSS('opacity', '1');
    for (const firstRepository of [26, 51]) {
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await scroll.dispatchEvent('scroll');
      await expect(view.locator('tbody > tr').first()).toContainText(`repository-${firstRepository}`);
      await expect(view.locator('tbody > tr')).toHaveCount(50);
    }
  }

  await page.getByRole('button', { name: 'Cards' }).click();
  await page.getByRole('button', { name: 'Chart' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view-scrolled/);
  await expect(page.locator('.org-sidebar')).toBeVisible();
  await expect(view).toBeHidden();
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(view).toBeVisible();
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view/);
  const mobileViewportHeight = await page.evaluate(() => innerHeight);
  expect((await view.boundingBox())?.height).toBeGreaterThanOrEqual(mobileViewportHeight / 2);
  await expectTableFilterIsContained(view.locator('.table-scroll > .table-filter'));
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);

  await page.setViewportSize({ width: 1000, height: 900 });

  await view.locator('.table-scroll').evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view-scrolled/);
  await expect(page.locator('.top-nav')).toBeHidden();
  await expect(page.locator('.org-sidebar')).toBeVisible();
  expect((await lazyList.boundingBox())?.height).toBeGreaterThanOrEqual(830);
});

test('full-view scrolling with a small overscroll range does not jitter the app chrome', async ({ page }) => {
  test.slow();
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 1000, height: 900 });

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const metadata = {
        'source-id': 'small-overscroll-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-01T03:00:00Z',
        'retrieved-at': '2026-09-01T03:01:00Z',
        'coverage-start': '2026-08-31T03:00:00Z',
        'coverage-end': '2026-09-01T03:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        inventory: {
          source: 'inventory',
          rows: Array.from({ length: 20 }, (_, index) => ({
            organization: 'githubnext',
            repository: \`repository-\${index + 1}\`
          })),
          metadata
        }
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'small-overscroll-layout',
          title: 'Small Overscroll Layout',
          pages: [{
            id: 'inventory',
            kind: 'custom',
            title: 'Inventory',
            views: [{
              id: 'inventory-list',
              title: 'Inventory list',
              data: { source: 'inventory' },
              mark: 'table',
              controls: 'interactive',
              layout: 'full-view',
              encoding: {
                columns: [
                  { field: 'organization', type: 'nominal' },
                  { field: 'repository', type: 'nominal' }
                ]
              }
            }]
          }],
          navigation: [{ label: 'Explore', pages: ['inventory'] }]
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const view = page.locator('[data-view-layout="full-view"]');
  const dashboardRoot = page.locator('.dashboard-root');
  const scroll = view.locator('.table-scroll');
  await expect(view).toHaveCount(1);

  // Force a small scrollable range (below the minimum jitter-guard threshold) regardless of
  // the exact table height rendered by the browser, so the test is deterministic.
  await scroll.evaluate((element) => {
    Object.defineProperty(element, 'scrollHeight', { value: element.clientHeight + 20, configurable: true });
  });

  for (const scrollTop of [10, 30, 10, 30, 0]) {
    await scroll.evaluate((element, top) => {
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    }, scrollTop);
    await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view-scrolled/);
    await expect(page.locator('.top-nav')).toBeVisible();
    await expect(page.locator('.org-sidebar')).toBeVisible();
  }
});

test('full-view mobile chrome stays stable while a repositories table scrolls', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const metadata = {
        'source-id': 'mobile-full-view-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-01T03:00:00Z',
        'retrieved-at': '2026-09-01T03:01:00Z',
        'coverage-start': '2026-08-31T03:00:00Z',
        'coverage-end': '2026-09-01T03:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        inventory: {
          source: 'inventory',
          rows: Array.from({ length: 60 }, (_, index) => ({
            organization: 'githubnext',
            repository: \`repository-\${index + 1}\`
          })),
          metadata
        }
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'mobile-full-view-layout',
          title: 'Mobile Full View Layout',
          pages: [{
            id: 'inventory',
            kind: 'custom',
            title: 'Inventory',
            views: [{
              id: 'inventory-list',
              title: 'Inventory list',
              data: { source: 'inventory' },
              mark: 'table',
              controls: 'interactive',
              'lazy-list': true,
              layout: 'full-view',
              encoding: {
                columns: [
                  { field: 'organization', type: 'nominal' },
                  { field: 'repository', type: 'nominal' }
                ]
              }
            }]
          }],
          navigation: [{ label: 'Explore', pages: ['inventory'] }]
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const view = page.locator('[data-view-layout="full-view"]');
  const dashboardRoot = page.locator('.dashboard-root');
  const scroll = view.locator('.table-scroll');
  const sidebar = page.locator('.org-sidebar');
  await expect(view).toHaveCount(1);
  await expect(sidebar).toBeVisible();
  const restingBox = await sidebar.boundingBox();
  assert(restingBox);

  for (const scrollTop of [100, 30, 120, 0]) {
    await scroll.evaluate((element, top) => {
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    }, scrollTop);
    await expect(dashboardRoot).not.toHaveClass(/dashboard-full-view-scrolled/);
    await expect(sidebar).toBeVisible();
    expect(await sidebar.boundingBox()).toEqual(restingBox);
  }
});

test('pie charts match the report layout at medium viewport widths', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 800, height: 900 });

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'pie-layout',
          title: 'Pie Layout',
          pages: [{
            id: 'cost',
            kind: 'custom',
            title: 'Cost',
            views: [{
              id: 'repository-allocation',
              title: 'AI Credit usage by AW repository',
              description: 'Read-only usage reported by AW runs.',
              data: { source: 'usage' },
              mark: 'chart',
              chart: 'pie',
              encoding: {
                x: { field: 'repository', type: 'nominal', title: 'Repository' },
                y: { field: 'aic', type: 'quantitative', aggregate: 'sum', title: 'Blocked requests' }
              }
            }]
          }],
          navigation: [{ label: 'Investigate', pages: ['cost'] }]
        }
      };
      const sources = {
        usage: {
          source: 'usage',
          rows: [
            { repository: 'a-very-long-repository-name-that-must-wrap-within-the-legend', aic: 4_280_186 },
            { repository: 'service', aic: 2_568_112 }
          ],
          metadata: {
            'source-id': 'pie-layout-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-01T03:00:00Z',
            'retrieved-at': '2026-09-01T03:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const heading = page.getByRole('heading', { name: 'AI Credit usage by AW repository' });
  const card = page.locator('.pie-chart-card');
  const description = card.locator('.view-description');
  const layout = page.locator('.pie-chart-layout');
  const chart = layout.locator('.pie-chart-widget');
  const legend = layout.locator('.chart-legend-pie');
  const table = page.locator('.chart-view-pie > .table-region');
  const [headingBox, descriptionBox, layoutBox, chartBox, legendBox, cardBox] = await Promise.all(
    [heading, description, layout, chart, legend, card].map((locator) => locator.boundingBox())
  );

  expect(headingBox).not.toBeNull();
  expect(descriptionBox).not.toBeNull();
  expect(layoutBox).not.toBeNull();
  expect(chartBox).not.toBeNull();
  expect(legendBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  await expect(table).toHaveCount(0);
  expect(layoutBox?.x).toBeCloseTo(headingBox?.x ?? 0, 0);
  expect(layoutBox?.y).toBeGreaterThan((descriptionBox?.y ?? 0) + (descriptionBox?.height ?? 0));
  expect(legendBox?.x).toBeGreaterThan((chartBox?.x ?? 0) + (chartBox?.width ?? 0));
  expect((legendBox?.x ?? 0) + (legendBox?.width ?? 0))
    .toBeLessThanOrEqual((cardBox?.x ?? 0) + (cardBox?.width ?? 0));
  expect((legendBox?.y ?? 0) + (legendBox?.height ?? 0) / 2)
    .toBeCloseTo((chartBox?.y ?? 0) + (chartBox?.height ?? 0) / 2, 0);
  const segmentGeometry = await chart.locator('.pie-chart-segment').evaluateAll((segments) => ({
    lengths: segments.map((segment) => /** @type {SVGGeometryElement} */ (segment).getTotalLength()),
    dashArrays: segments.map((segment) => getComputedStyle(segment).strokeDasharray),
    lineCaps: segments.map((segment) => getComputedStyle(segment).strokeLinecap),
    transforms: segments.map((segment) => getComputedStyle(segment).transform),
    vectorEffects: segments.map((segment) => getComputedStyle(segment).vectorEffect)
  }));
  expect(segmentGeometry.lengths[0]).toBeCloseTo(56.5, 1);
  expect(segmentGeometry.lengths[1]).toBeCloseTo(31.5, 1);
  expect(segmentGeometry.lengths.reduce((sum, length) => sum + length, 0)).toBeCloseTo(88, 1);
  expect(segmentGeometry.dashArrays).toEqual(['none', 'none']);
  expect(segmentGeometry.lineCaps).toEqual(['round', 'round']);
  expect(segmentGeometry.transforms).toEqual(['none', 'none']);
  expect(segmentGeometry.vectorEffects).toEqual(['none', 'none']);
  const centerTextGeometry = await chart.locator('svg').evaluate((svg) => {
    const total = /** @type {SVGGraphicsElement} */ (svg.querySelector('.pie-chart-total-value'));
    const label = /** @type {SVGGraphicsElement} */ (svg.querySelector('.pie-chart-total-label'));
    return [total.getBBox(), label.getBBox()].map(({ x, width }) => ({ x, width }));
  });
  for (const { x, width } of centerTextGeometry) {
    expect(x).toBeGreaterThanOrEqual(9);
    expect(x + width).toBeLessThanOrEqual(33);
  }

  const firstMark = chart.locator('.pie-chart-mark').first();
  expect(await firstMark.evaluate((mark) => {
    mark.focus();
    return mark === mark.parentElement?.lastElementChild;
  })).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const tableToggle = layout.getByRole('button', { name: 'Hide chart table' });
  await expect(legend).toBeVisible();
  await expect(tableToggle).toBeVisible();
  await tableToggle.click();
  await expect(legend).toBeHidden();
  await layout.getByRole('button', { name: 'Show chart table' }).click();
  await expect(legend).toBeVisible();
});

test('DLS-PAGE-014 DLS-PAGE-015 built-in campaigns page renders dispatches, inventory, and campaign activity in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const queryDefinitions = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8')).dashboard.queries;
  const campaignInsightsPage = authoritativeDashboard.dashboard.pages.find(
    (/** @type {{ id?: string }} */ candidate) => candidate.id === 'campaign-insights'
  );
  const campaignProblemsPage = authoritativeDashboard.dashboard.pages.find(
    (/** @type {{ id?: string }} */ candidate) => candidate.id === 'campaign-problems'
  );
  const campaignIssuesPage = authoritativeDashboard.dashboard.pages.find(
    (/** @type {{ id?: string }} */ candidate) => candidate.id === 'campaign-issues'
  );
  assert(campaignInsightsPage, 'Missing campaign insights page');
  assert(campaignProblemsPage, 'Missing campaign problems page');
  assert(campaignIssuesPage, 'Missing campaign issues page');

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { setDeclaredCliActions } from 'http://dashboard.test/src/components/cli-actions.js';
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';

      window.localStorage.setItem(
        'central-agentic-ops.dashboard.horizon-filter-settings',
        JSON.stringify({ range: 'all' })
      );
      setDeclaredCliActions([{
        id: 'update-campaign',
        label: 'Update campaign',
        description: "Update this campaign's agentic workflow.",
        icon: 'sync',
        command: 'gh aw update {{campaign}}',
        placement: 'row'
      }], { canExecute: false });

      const metadata = {
        'source-id': 'campaigns-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-14T16:00:00Z',
        'retrieved-at': '2026-09-14T16:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const documentModel = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'campaigns-render',
          title: 'Central Agentic Ops',
          queries: ${JSON.stringify(queryDefinitions)},
          pages: [
            ${JSON.stringify(builtInPage('campaigns', {
              id: 'campaigns',
              title: 'Campaigns',
              description: 'Activity from centrally managed campaigns.',
            }))},
            ${JSON.stringify(campaignInsightsPage)},
            ${JSON.stringify(campaignProblemsPage)},
            {
              id: 'campaign-detail',
              kind: 'custom',
              title: 'Campaign',
              route: { 'hash-query-parameter': 'campaign' },
              views: [
                {
                  id: 'campaign-workflow-navigation',
                  title: 'Campaign workflows',
                  data: { sources: ['workflows', 'campaign-insight-tab-counts', 'campaign-problem-tab-counts', 'campaign-issue-tab-counts'] },
                  mark: 'element',
                  element: 'campaign-route',
                  config: { body: 'overview' }
                }
              ]
            },
            {
              id: 'campaign-workflows',
              kind: 'custom',
              title: 'Campaign',
              route: { 'hash-query-parameter': 'campaign' },
              views: [
                {
                  id: 'campaign-workflow-navigation',
                  title: 'Campaign workflows',
                  data: { sources: ['workflows', 'campaign-insight-tab-counts', 'campaign-problem-tab-counts', 'campaign-issue-tab-counts'] },
                  mark: 'element',
                  element: 'campaign-route',
                  config: { body: 'workflows' }
                },
                {
                  id: 'campaign-workflow-table',
                  title: 'Orchestrator and workers',
                  data: { source: 'campaign-workflows', 'route-field': 'campaign' },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    columns: [
                      { field: 'workflow-role', type: 'ordinal', title: 'Role', display: 'label' },
                      { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                      { field: 'workflow', type: 'nominal', title: 'Definition' },
                      { field: 'rollout-mode', type: 'nominal', title: 'Mode', display: 'mode' },
                      { field: 'workflow-active', type: 'nominal', title: 'Registration', display: 'active-state' },
                      { field: 'runs', type: 'quantitative', title: 'Runs' },
                      { field: 'aic', type: 'quantitative', title: 'Total AIC', unit: 'aic' }
                    ]
                  }
                }
              ]
            },
            {
              id: 'campaign-runs',
              kind: 'custom',
              title: 'Campaign',
              route: { 'hash-query-parameter': 'campaign' },
              views: [
                {
                  id: 'campaign-run-navigation',
                  title: 'Campaign workflow runs',
                  data: { sources: ['workflows', 'campaign-insight-tab-counts', 'campaign-problem-tab-counts', 'campaign-issue-tab-counts'] },
                  mark: 'element',
                  element: 'campaign-route',
                  config: { body: 'runs' }
                },
                {
                  id: 'campaign-run-status',
                  title: 'Workflow run status',
                  data: { source: 'campaign-runs', 'route-field': 'campaign' },
                  mark: 'chart',
                  chart: 'pie',
                  'empty-message': 'No workflow runs were observed for this campaign in the current run window.',
                  encoding: {
                    x: { field: 'status', type: 'nominal', title: 'Status' },
                    y: { field: 'started-at', type: 'quantitative', aggregate: 'count', title: 'Runs' }
                  }
                },
                {
                  id: 'campaign-failure-reason-distribution',
                  title: 'Why these dispatches failed',
                  data: {
                    source: 'dispatches',
                    'route-field': 'campaign',
                    filters: { status: ['failure', 'startup-failure', 'timed-out', 'stale'] },
                    'order-by': [{ field: 'count-status-detail', direction: 'desc' }]
                  },
                  mark: 'chart',
                  chart: 'pie',
                  'empty-message': 'No failed workflow dispatch runs were observed for this campaign in the current run window.',
                  encoding: {
                    x: { field: 'status-detail', type: 'nominal', title: 'Failure reason' },
                    y: { field: 'status-detail', type: 'quantitative', aggregate: 'count', title: 'Failed dispatches' }
                  }
                },
                {
                  id: 'campaign-failed-dispatch-table',
                  title: 'Failed dispatches',
                  data: { source: 'dispatches', 'route-field': 'campaign', filters: { status: ['failure', 'startup-failure', 'timed-out', 'stale'] } },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    href: { field: 'run-link', type: 'nominal' },
                    columns: [
                      { field: 'status-detail', type: 'nominal', title: 'Why' },
                      { field: 'started-at', type: 'temporal', title: 'Started' },
                      { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                      { field: 'run-title', type: 'nominal', title: 'Run title' },
                      { field: 'runtime-repository', type: 'nominal', title: 'Runtime repository' }
                    ],
                    actions: [{
                      intent: 'Debug this failed workflow dispatch.',
                      presentation: 'copy-prompt',
                      icon: 'search',
                      label: 'Review debug prompt',
                      context: ['campaign', 'status', 'status-detail', 'started-at', 'workflow-name', 'run-title', 'runtime-repository', 'run-link']
                    }]
                  }
                },
                {
                  id: 'campaign-run-table',
                  title: 'All workflow runs',
                  data: { source: 'campaign-runs', 'route-field': 'campaign' },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    href: { field: 'run-link', type: 'nominal' },
                    columns: [
                      { field: 'started-at', type: 'temporal', title: 'Started' },
                      { field: 'dispatch-type', type: 'nominal', title: 'Type' },
                      { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                      { field: 'run-title', type: 'nominal', title: 'Run title' },
                      { field: 'runtime-repository', type: 'nominal', title: 'Runtime repository' },
                      { field: 'status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'status-detail', type: 'nominal', title: 'Why' }
                    ]
                  }
                }
              ]
            },
            ${JSON.stringify(campaignIssuesPage)},
            {
              id: 'campaign-reports',
              kind: 'custom',
              title: 'Campaign',
              route: { 'hash-query-parameter': 'campaign' },
              views: [
                {
                  id: 'campaign-report-navigation',
                  title: 'Campaign reports',
                  data: { sources: ['workflows', 'campaign-insight-tab-counts', 'campaign-problem-tab-counts', 'campaign-issue-tab-counts'] },
                  mark: 'element',
                  element: 'campaign-route',
                  config: { body: 'reports' }
                },
                {
                  id: 'campaign-report-table',
                  title: 'Reports',
                  data: { source: 'campaign-reports', 'route-field': 'campaign' },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    columns: [
                      { field: 'outcome-title', type: 'nominal', title: 'Report', display: 'outcome-link' },
                      { field: 'outcome-status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'rollout-mode', type: 'nominal', title: 'Mode', display: 'mode' },
                      { field: 'outcome-category', type: 'nominal', title: 'Type' },
                      { field: 'observed-at', type: 'temporal', title: 'Updated' }
                    ]
                  }
                }
              ]
            }
          ]
        }
      };
      const sources = {
        campaigns: {
          source: 'campaigns',
          rows: [
            { campaign: 'ambient-context', 'campaign-name': 'Ambient Context', 'campaign-icon': 'workflow', 'campaign-link': { 'dashboard-href': '#page-campaign-insights?campaign=ambient-context', 'dashboard-label': 'View Ambient Context campaign dashboard' } },
            { campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'campaign-icon': 'gear', 'campaign-link': { 'dashboard-href': '#page-campaign-insights?campaign=aw-doctor', 'dashboard-label': 'View AW Doctor campaign dashboard' } }
          ],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', 'campaign-name': 'Ambient Context', 'campaign-icon': 'workflow', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 250, 'campaign-aic-allowance': 1050, 'campaign-inventory-warnings': 0 },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', 'campaign-name': 'Ambient Context', 'campaign-icon': 'workflow', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', 'workflow-role': 'worker', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 800, 'campaign-aic-allowance': 1050, 'campaign-inventory-warnings': 0 },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'campaign-icon': 'gear', workflow: '.github/workflows/aw-doctor.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 250, 'campaign-aic-allowance': 1250, 'campaign-inventory-warnings': 1 }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '3', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-09-14T14:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-09-14T15:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/3', label: 'Run 3' } },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '5', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-09-14T13:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-09-14T15:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/5', label: 'Run 5' } },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '6', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-09-14T12:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-09-14T15:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/6', label: 'Run 6' } },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '7', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-09-14T11:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-09-14T15:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/7', label: 'Run 7' } },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '8', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-09-14T10:00:00Z', 'run-conclusion': 'failure', 'failure-job': 'pre_activation', 'failure-message': 'Target authority missing: add .github/workflows/cao.json to the target default branch for live mode', 'failure-step': 'Run CAO control precompute', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/8', label: 'Run 8' } },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/aw-doctor.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review', 'aic-total': 23.9 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/aw-doctor.md', run: '2', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'live' }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/aw-doctor.md', run: '1', invocation: 'a', aic: 23.9, 'rollout-mode': 'review' }
          ],
          metadata: { ...metadata, completeness: 'partial' }
        },
        findings: {
          source: 'findings',
          rows: [
            { workflow: '.github/workflows/aw-doctor.md', run: '2', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:05:00Z' }
          ],
          metadata
        },
        audits: {
          source: 'audits',
          rows: [],
          metadata
        },
        tools: {
          source: 'tools',
          rows: [],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', run: '3', 'run-conclusion': 'success', 'safe-output': 'ambient-review', 'outcome-title': 'Review ambient context proposal', 'outcome-summary': 'A review proposal is ready.', 'outcome-category': 'issue', 'outcome-status': 'open', 'outcome-state': 'pending', 'rollout-mode': 'review', 'published-at': '2026-08-29T18:00:00Z', 'observed-at': '2026-08-29T18:05:00Z' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', run: '4', 'run-conclusion': 'success', 'safe-output': 'ambient-worker-issue', 'outcome-title': 'Review worker finding', 'outcome-summary': 'A worker finding is ready.', 'outcome-category': 'issue', 'outcome-status': 'open', 'outcome-state': 'pending', 'rollout-mode': 'review', 'published-at': '2026-08-28T19:00:00Z', 'observed-at': '2026-08-28T19:05:00Z' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', run: '4', 'run-conclusion': 'success', 'safe-output': 'ambient-live', 'outcome-title': 'Reconcile ambient context', 'outcome-summary': 'Updated durable guidance.', 'outcome-category': 'pull-request', 'outcome-status': 'closed', 'outcome-state': 'lifecycle-close', 'rollout-mode': 'live', 'published-at': '2026-08-28T18:00:00Z', 'observed-at': '2026-08-28T18:05:00Z' },
            { campaign: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '1', 'run-conclusion': 'success', 'safe-output': 'maintenance-review', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' },
            { campaign: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '2', 'run-conclusion': 'failure', 'safe-output': 'maintenance-live', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:00:00Z' }
          ],
          metadata
        },
        'operational-graders': {
          source: 'operational-graders',
          rows: [
            {
              organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '3',
              'observed-at': '2026-09-13T14:00:00Z', 'operational-grader': 0.5, 'operational-grader-definition': 'repository-readiness',
              diagnostics: { quality: 0.6, efficiency: 0.8 },
              'diagnostic-definitions': [{ id: 'quality', name: 'Quality' }, { id: 'efficiency', name: 'Efficiency' }]
            },
            {
              organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/ambient-context-worker.md', run: '4',
              'observed-at': '2026-09-14T14:00:00Z', 'operational-grader': 0.75, 'operational-grader-definition': 'repository-readiness',
              diagnostics: { quality: 0.85, efficiency: 0.7 },
              'diagnostic-definitions': [{ id: 'quality', name: 'Quality' }, { id: 'efficiency', name: 'Efficiency' }]
            },
            { workflow: '.github/workflows/aw-doctor.md', run: '1', 'operational-grader': 0.25 }
          ],
          metadata
        }
      };

      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        documentModel,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      const viewSources = await loadPageSources('campaigns', {});
      document.querySelector('#root').append(renderDashboard({
        document: documentModel,
        sources: viewSources,
        loadPageSources
      }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Campaigns', level: 1 })).toBeVisible();
  const dispatchChart = page.locator('[data-view-id="campaigns-dispatches"]');
  await expect(dispatchChart.locator('[data-chart-widget="pie"]')).toBeVisible();
  await expect(dispatchChart.locator('.chart-legend-pie')).toContainText('Ambient Context');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.locator('[data-page-id="campaigns"] [data-view-layout="full-view"]')).toBeVisible();
  await expect(page.locator('[data-page-id="campaigns"] [data-lazy-list]')).toBeVisible();
  await expect(page.locator('[data-page-id="campaigns"] [data-table-filter]')).toBeVisible();
  await expect(page.locator('[data-page-id="campaigns"] .table-summary-row')).toBeVisible();
  const campaignRows = page.locator('[data-page-id="campaigns"] .custom-table tbody tr');
  await expect(campaignRows).toHaveCount(2);
  await expect(page.locator('[data-page-id="campaigns"] .custom-table thead tr').first().locator('th')).toHaveText([
    'Campaign',
    'Workflows',
    'Roles',
    'Modes',
    'Runs',
    'Dispatches',
    'AIC',
    'Ops Grader',
    'Registration'
  ]);
  const awDoctorSummary = campaignRows.filter({ hasText: 'AW Doctor' });
  await expect(awDoctorSummary).toContainText('AW Doctor');
  await expect(awDoctorSummary).toContainText('23.9');
  await expect(awDoctorSummary.locator('[data-field="grader-result"]')).toHaveText('0.25');
  await expect(awDoctorSummary.getByRole('button', { name: 'Update campaign' })).toHaveCount(0);
  await expect(awDoctorSummary.getByRole('link', { name: 'View AW Doctor campaign dashboard' })).toHaveAttribute('href', '#page-campaign-insights?campaign=aw-doctor');
  await expect(awDoctorSummary.locator('[data-field="modes"] .mode-badge')).toHaveText('review');
  await expect(awDoctorSummary.locator('[data-field="registration"] .status')).toHaveText('Active');
  await page.getByRole('button', { name: 'Cards' }).click();
  const awDoctorCard = page.locator('[data-page-id="campaigns"] [data-mobile-card-list] .entity-card-list-card').filter({ hasText: 'AW Doctor' });
  await expect(awDoctorCard.locator('[data-card-drill]')).toHaveAttribute('href', '#page-campaign-insights?campaign=aw-doctor');
  await awDoctorCard.click({ position: { x: 6, y: 6 } });
  await expect(page).toHaveURL(/#page-campaign-insights\?campaign=aw-doctor$/);
  await expect(page.locator('[data-page-id="campaign-insights"] .campaign-tabs')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#page-campaign-detail?campaign=ambient-context';
  });
  await expect(page.locator('[data-breadcrumb-page]')).toHaveText('Ambient Context');
  await expect(page.locator('[data-page-mode]')).toBeHidden();
  await expect(page.locator('[data-nav-page-id="campaigns"]')).toHaveAttribute('aria-current', 'page');
  const campaignNavigation = page.getByRole('navigation', { name: 'Ambient Context views' });
  await expect(campaignNavigation.getByRole('link')).toHaveCount(3);
  await expect(campaignNavigation).toHaveCSS('display', 'flex');
  await expect(campaignNavigation).toHaveCSS('border-bottom-style', 'solid');
  await expect(campaignNavigation.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(campaignNavigation.locator('.count-badge')).toHaveText(['3', '1']);
  const campaignTabBadges = await campaignNavigation.locator('.count-badge').allTextContents();
  await expect(page.getByRole('heading', { name: 'Orchestrator and workers', level: 3 })).toHaveCount(0);
  await campaignNavigation.getByRole('link', { name: 'Problems' }).click();
  await expect(page).toHaveURL(/#page-campaign-problems\?campaign=ambient-context$/);
  await expect(campaignNavigation.getByRole('link', { name: 'Problems' })).toHaveAttribute('aria-current', 'page');
  expect(await campaignNavigation.locator('.count-badge').allTextContents()).toEqual(campaignTabBadges);
  await expect(page.locator('[data-page-id="campaign-problems"] [data-view-id="campaign-current-runtime-problems"]')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#page-campaign-workflows?campaign=ambient-context';
  });
  await expect(campaignNavigation.locator('[aria-current="page"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('heading', { name: 'Orchestrator and workers', level: 3 })).toBeVisible();
  const campaignWorkflowRows = page.locator('[data-page-id="campaign-workflows"] .custom-table tbody tr');
  await expect(campaignWorkflowRows).toHaveCount(2);
  await expect(page.locator('[data-page-id="campaign-workflows"] .custom-table thead tr').first().locator('th')).toHaveText([
    'Role',
    'Workflow',
    'Definition',
    'Mode',
    'Registration',
    'Runs',
    'Total AIC'
  ]);
  await expect(campaignWorkflowRows.first()).toContainText('OrchestratorAmbient Context');
  await expect(campaignWorkflowRows.first().locator('td').nth(5)).toHaveText('0');
  await expect(campaignWorkflowRows.first().locator('td').nth(6)).toHaveText('0');
  await expect(campaignWorkflowRows.nth(1)).toContainText('WorkerAmbient Context Worker');
  await page.evaluate(() => {
    window.location.hash = '#page-campaign-runs?campaign=ambient-context';
  });
  await expect(page).toHaveURL(/#page-campaign-runs\?campaign=ambient-context$/);
  const campaignRunsPage = page.locator('[data-page-id="campaign-runs"]');
  await expect(campaignRunsPage.locator('.custom-view-grid > .custom-view').first()).toHaveAttribute('data-view-id', 'campaign-run-navigation');
  await expect(campaignNavigation.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(campaignRunsPage.locator('[data-view-id="campaign-run-status"] [data-chart-widget="pie"]')).toBeVisible();
  await expect(campaignRunsPage.locator('[data-view-id="campaign-failure-reason-distribution"] [data-chart-widget="pie"]')).toBeVisible();
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(campaignRunsPage.locator('[data-view-id="campaign-run-table"] tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'Chart' }).click();
  await campaignNavigation.getByRole('link', { name: 'Issues' }).click();
  await expect(campaignNavigation.getByRole('link', { name: 'Issues' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Cards' }).click();
  const campaignIssueView = page.locator('[data-page-id="campaign-issues"] [data-view-id="campaign-issue-table"]');
  await expect(campaignIssueView).toBeVisible();
  await expect(campaignIssueView).toContainText('Review worker finding');
  await expect(campaignIssueView.getByRole('listitem')).toHaveCount(1);
  await expect(campaignIssueView).not.toContainText('Review ambient context proposal');
  expect(await campaignNavigation.locator('.count-badge').allTextContents()).toEqual(campaignTabBadges);
  await page.getByRole('button', { name: 'Chart' }).click();
  await page.evaluate(() => {
    window.location.hash = '#page-campaign-detail?campaign=ambient-context';
  });
  await expect(page.locator('[data-page-id="campaign-detail"]')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(campaignNavigation).toHaveCSS('display', 'grid');
  await expect(campaignNavigation).toHaveCSS('gap', '0px');
  await expect(campaignNavigation).toHaveCSS('overflow', 'hidden');
  const mobileCampaignLinks = campaignNavigation.locator('a');
  await expect(mobileCampaignLinks).toHaveCount(3);
  await expect(mobileCampaignLinks.first().locator('.tab-trailing-icon')).toBeVisible();
  expect(await mobileCampaignLinks.first().evaluate((link) => {
    return link.lastElementChild?.classList.contains('tab-trailing-icon') === true;
  })).toBe(true);
  await expect.poll(() => mobileCampaignLinks.first().evaluate((link) => {
    link.focus();
    return getComputedStyle(link).outlineOffset;
  })).toBe('-3px');
  const mobileLinkBoxes = await mobileCampaignLinks.evaluateAll((links) => links.map((link) => {
    const box = link.getBoundingClientRect();
    return { height: box.height, top: box.top };
  }));
  expect(mobileLinkBoxes.every((box) => box.height >= 44)).toBe(true);
  expect(mobileLinkBoxes.every((box, index) => index === 0 || box.top > mobileLinkBoxes[index - 1].top)).toBe(true);

  await campaignNavigation.getByRole('link', { name: 'Insights' }).click();
  const campaignInsights = page.locator('[data-page-id="campaign-insights"]');
  await expect(campaignInsights).toBeVisible();
  await expect(campaignInsights).toHaveAttribute('data-view-mode', 'chart');
  await expect(campaignInsights.locator('.view-mode-control')).toHaveCount(0);
  await expect(campaignInsights.getByRole('navigation', { name: 'Ambient Context views' })).toBeVisible();
  await expect(campaignInsights.getByRole('navigation', { name: 'Ambient Context views' })).toHaveCSS('display', 'grid');
  const mobileBack = page.getByRole('button', { name: 'Go back' });
  await expect(mobileBack).toBeVisible();
  await expect(page.locator('.overview-header')).toContainText('Operational activity for the Ambient Context campaign.');
  await expect(campaignInsights.locator('.measure-history [data-chart-widget="line"]')).toHaveCount(3);
  await expect(campaignInsights.locator('.measure-history .chart-point')).toHaveCount(6);
  await expect(campaignInsights.locator('.measure-history')).toContainText('Repository readiness');
  await expect(campaignInsights.locator('.measure-history')).toContainText('Quality');
  await expect(campaignInsights.locator('.measure-history')).toContainText('Efficiency');
  await expect(campaignInsights.locator('.insights-measure-rows > .insights-measure-row')).toHaveCount(3);
  await expect(campaignInsights.locator('.insights-measure-row').first().locator('.insights-axis-x')).toHaveText('Observation time (UTC)');
  const measureReadout = campaignInsights.locator('.insights-measure-row').first().locator('.insights-point-readout');
  await expect(measureReadout).toHaveText('Select a point to inspect that observation.');
  const measurePoint = campaignInsights.locator('.insights-measure-row').first().locator('.chart-point[data-chart-point-key]').first();
  await measurePoint.dispatchEvent('click');
  await expect(measureReadout).not.toHaveText('Select a point to inspect that observation.');
  await expect(campaignInsights.locator('.insights-measure-row .chart-point[aria-pressed="true"]')).toHaveCount(1);
  await measurePoint.dispatchEvent('keydown', { key: 'Enter', bubbles: true });
  await expect(measureReadout).toHaveText('Select a point to inspect that observation.');
  await mobileBack.click();
  await expect(page).toHaveURL(/#page-campaign-detail\?campaign=ambient-context$/);
  await expect(page.locator('[data-page-id="campaign-detail"]')).toBeVisible();
  await expect(campaignNavigation).toBeVisible();
});


test('DLS-PAGE-009 DLS-PAGE-014 built-in evals page renders distinguishable definitions and observations, observed subject, YES/NO/UNKNOWN result, evaluation model when available, time, provenance, and independent data state in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'built-in-evals-render',
          title: 'Built In Evals Render',
          pages: [
            ${JSON.stringify(builtInPage('evals', { id: 'evals', title: 'Evals' }))}
          ]
        }
      };

      const sources = {
        evals: {
          source: 'evals',
          rows: [
            { eval: 'release-risk', 'eval-name': 'Release Risk', 'eval-question': 'Is the release risky?', 'requested-model': 'gpt-4o', 'observed-at': '2026-08-29T09:00:00Z' },
            { eval: 'doc-quality', 'eval-name': 'Documentation Quality', 'eval-question': 'Is the documentation complete?', 'requested-model': 'claude-3.5', 'observed-at': '2026-08-29T09:05:00Z' }
          ],
          metadata: {
            'source-id': 'evals-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        'eval-observations': {
          source: 'eval-observations',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', eval: 'release-risk', 'eval-result': 'YES', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', eval: 'release-risk', 'eval-result': 'UNKNOWN', 'requested-model': 'gpt-4o', 'resolved-model': '', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:10:00Z' },
            { organization: 'octo-org', repository: 'octo-repo', workflow: '.github/workflows/nightly.yml', run: '2001', eval: 'doc-quality', 'eval-result': 'NO', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7', 'rollout-mode': 'review', 'observed-at': '2026-08-29T10:20:00Z' }
          ],
          metadata: {
            'source-id': 'eval-observations-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Evals', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Table' }).click();
  await page.locator('summary').filter({ hasText: 'Evals Evals Source' }).click();
  await expect(page.getByRole('region', { name: 'Evals Evals Source', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Evals Observations Source' }).click();
  await expect(page.getByRole('region', { name: 'Evals Observations Source', exact: true })).toBeVisible();
  await expect(page.locator('.data-state-summary')).toBeHidden();
  await expect(page.locator('[data-page-id="evals"] .custom-table').nth(0).locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('[data-page-id="evals"] .custom-table').nth(1).locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-page-id="evals"]')).toContainText('release-risk');
  await expect(page.locator('[data-page-id="evals"]')).toContainText('UNKNOWN');
  await expect(page.locator('[data-page-id="evals"]')).toContainText('claude-3.7');
});

test('DLS-SAFE-004 DLS-SAFE-007 DLS-SAFE-008 DLS-SAFE-010 built-in findings page exposes accessible names, labeled columns, textual data states, and only safe labeled external links in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <a id="plain-external-link" href="https://example.com/docs">External documentation</a>
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'security-dashboard',
          title: 'Security Dashboard',
          repository: 'githubnext/gh-aw-cao',
          pages: [
            ${JSON.stringify(builtInPage('findings', { id: 'findings', title: 'Findings' }))}
          ]
        }
      };

      const sources = {
        findings: {
          source: 'findings',
          rows: [
            {
              finding: 'unsafe-html',
              'finding-summary': '<img src=x onerror=alert(1)>',
              'finding-severity': 'critical',
              'finding-status': 'open',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              'observed-at': '2026-08-29T12:00:00Z',
              'issue-link': {
                relation: 'issue',
                href: 'https://example.com/issues/1',
                label: 'Issue 1 label'
              }
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Findings', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Table' }).click();
  await page.locator('summary').filter({ hasText: 'Findings Source' }).click();
  await expect(page.locator('.data-state-summary')).toBeHidden();
  await expect(page.getByRole('columnheader', { name: 'Issue Link' })).toBeVisible();
  await expect(page.locator('[data-page-id="findings"] .custom-table tbody td').first()).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('[data-page-id="findings"] .custom-table tbody img')).toHaveCount(0);

  const issueLink = page.getByRole('link', { name: 'Issue 1 label' });
  await expect(issueLink).toBeVisible();
  await expect(issueLink).toHaveAttribute('href', 'https://example.com/issues/1');
  await expect(issueLink).toHaveAttribute('target', '_blank');
  await expect(issueLink).toHaveAttribute('rel', 'noopener noreferrer');

  const externalLinkMask = await page.locator('#plain-external-link').evaluate((link) => getComputedStyle(link, '::after').maskImage);
  const repositoryLinkMask = await page.locator('.repository-link').evaluate((link) => getComputedStyle(link, '::after').maskImage);
  expect(externalLinkMask).not.toBe('none');
  await expect(page.locator('.refresh-button')).toHaveCount(0);
  expect(repositoryLinkMask).toBe('none');
});

test('DLS-VIEW-013 DLS-VIEW-014 DLS-VIEW-015 DLS-SAFE-006 custom views render available, empty, and unavailable states with only context-permitted observations in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'custom-dashboard',
          title: 'Custom Dashboard',
          pages: [
            {
              id: 'custom-views',
              kind: 'custom',
              title: 'Custom Views',
              views: [
                {
                  id: 'total-aic',
                  title: 'Total AI Credits',
                  data: {
                    source: 'usage',
                    filters: {
                      'rollout-mode': ['review', 'live']
                    }
                  },
                  mark: 'metric',
                  encoding: {
                    value: {
                      field: 'aic',
                      type: 'quantitative',
                      aggregate: 'sum'
                    }
                  }
                },
                {
                  id: 'findings-table',
                  title: 'Findings Table',
                  data: {
                    source: 'findings',
                    scope: {
                      repositories: ['gh-aw-cao']
                    },
                    time: {
                      start: '2026-08-29T00:00:00Z',
                      end: '2026-08-30T00:00:00Z'
                    }
                  },
                  mark: 'table',
                  encoding: {
                    columns: [
                      { field: 'finding-summary' },
                      { field: 'finding-severity' },
                      { field: 'finding-status' }
                    ],
                    href: {
                      field: 'pull-request-link'
                    }
                  }
                },
                {
                  id: 'daily-runs',
                  title: 'Daily Runs',
                  data: {
                    source: 'runs'
                  },
                  mark: 'chart',
                  encoding: {
                    x: {
                      field: 'started-at',
                      type: 'temporal',
                      'time-unit': 'day'
                    },
                    y: {
                      field: 'run',
                      type: 'quantitative',
                      aggregate: 'count'
                    },
                    color: {
                      field: 'run-conclusion',
                      type: 'nominal'
                    },
                    href: {
                      field: 'run-link'
                    }
                  }
                },
                {
                  id: 'empty-usage',
                  title: 'Empty Usage',
                  data: {
                    source: 'empty-usage'
                  },
                  mark: 'metric',
                  encoding: {
                    value: {
                      field: 'aic',
                      type: 'quantitative',
                      aggregate: 'sum'
                    }
                  }
                },
                {
                  id: 'missing-source',
                  title: 'Missing Source',
                  data: {
                    source: 'missing-source'
                  },
                  mark: 'table',
                  encoding: {
                    columns: [
                      { field: 'finding-summary' }
                    ]
                  }
                }
              ]
            }
          ]
        }
      };

      const sources = {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'live', aic: 2, 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'review', aic: 3, 'observed-at': '2026-08-29T11:00:00Z' }
          ],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        findings: {
          source: 'findings',
          rows: [
            {
              code: 'finding-1',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-29T12:00:00Z',
              'finding-summary': 'Unsafe dependency',
              'finding-severity': 'high',
              'finding-status': 'open',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/1',
                label: 'PR 1'
              }
            },
            {
              code: 'finding-2',
              organization: 'github',
              repository: 'other-repo',
              'observed-at': '2026-08-29T13:00:00Z',
              'finding-summary': 'Out of scope finding',
              'finding-severity': 'medium',
              'finding-status': 'resolved',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/2',
                label: 'PR 2'
              }
            },
            {
              code: 'finding-3',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-30T01:00:00Z',
              'finding-summary': 'Out of range finding',
              'finding-severity': 'low',
              'finding-status': 'open'
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        runs: {
          source: 'runs',
          rows: [
            {
              run: '1001',
              'started-at': '2026-08-29T10:00:00Z',
              'run-conclusion': 'success',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1001', label: 'Run 1001' }
            },
            {
              run: '1002',
              'started-at': '2026-08-29T11:00:00Z',
              'run-conclusion': 'failure',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1002', label: 'Run 1002' }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        'empty-usage': {
          source: 'empty-usage',
          rows: [],
          metadata: {
            'source-id': 'empty-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'unknown',
            freshness: 'unknown',
            availability: 'empty'
          }
        }
      };

      const viewSources = await prepareDashboardViewSources(dashboardDocument, 'custom-views', sources);
      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources: viewSources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Custom Views', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Total AI Credits' })).toBeVisible();
  await expect(page.locator('[data-metric-value="aic"]')).toHaveText('5');
  const metricSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Total AI Credits' }) });
  await expect(metricSection).not.toContainText('Source: usage');
  await expect(metricSection).not.toContainText('Filters:');

  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('heading', { name: 'Findings Table' })).toBeVisible();
  await expect(page.locator('.custom-table tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'PR 1' })).toHaveAttribute('href', 'https://example.com/pull/1');
  const tableSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Findings Table' }) });
  await expect(tableSection).not.toContainText('Scope:');
  await expect(tableSection).not.toContainText('Time:');
  await expect(tableSection).not.toContainText('Out of scope finding');
  await expect(tableSection).not.toContainText('Out of range finding');

  await page.getByRole('button', { name: 'Chart' }).click();
  await expect(page.getByRole('heading', { name: 'Daily Runs' })).toBeVisible();
  await expect(page.locator('.chart-default')).toHaveCount(0);
  await expect(page.locator('[data-chart-legend="text"]')).toHaveCount(0);
  await expect(page.locator('[data-chart-legend="visual"] li')).toHaveCount(2);
  await expect(page.locator('[data-chart-legend="visual"] li span')).toHaveText(['failure', 'success']);
  await expect(page.locator('.chart-view .table-region')).toHaveCount(0);
  await expect(page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Daily Runs' }) }).locator('.view-source')).toHaveCount(0);

  await hydrateView(page, 'Empty Usage');
  await expect(page.getByRole('heading', { name: 'Empty Usage' })).toBeVisible();
  await expect(page.locator('[data-view-availability="empty"]')).toHaveText('No observations matched the effective context.');
  const emptySection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Empty Usage' }) });
  await expect(emptySection).toContainText('Affected source: empty-usage');

  await page.getByRole('button', { name: 'Table' }).click();
  await hydrateView(page, 'Missing Source');
  await expect(page.getByRole('heading', { name: 'Missing Source' })).toBeVisible();
  await expect(page.locator('[data-view-availability="unavailable"]')).toHaveText('This view cannot be shown because its data source is unavailable.');
  const unavailableSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Missing Source' }) });
  await expect(unavailableSection).toContainText('Affected source: missing-source');
});

test('DLS-SAFE-007 DLS-SAFE-008 keyboard navigation moves across labeled page sections in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard, enableDashboardKeyboardNavigation } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'runs-dashboard',
          title: 'Runs Dashboard',
          pages: [
            {
              id: 'keyboard-navigation',
              kind: 'custom',
              title: 'Keyboard Navigation',
              views: [
                { id: 'runs-source', data: { source: 'runs' } },
                { id: 'outcomes-source', data: { source: 'outcomes' } }
              ]
            }
          ]
        }
      };

      const sources = {
        runs: {
          source: 'runs',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'rollout-mode': 'live',
              engine: 'actions',
              'requested-model': 'gpt-4o',
              'resolved-model': 'gpt-4.1',
              'started-at': '2026-08-29T10:00:00Z',
              'run-link': {
                relation: 'run',
                href: 'https://example.com/runs/1001',
                label: 'Run 1001'
              }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            { run: '1001', 'outcome-state': 'accepted' }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      const root = document.querySelector('#root');
      const dashboard = renderDashboard({ document: dashboardDocument, sources });
      root.append(dashboard);
      enableDashboardKeyboardNavigation(dashboard);
    </script>
  `);

  const sections = page.locator('[data-page-id="keyboard-navigation"] .page-section');
  await expect(sections).toHaveCount(2);
  await expect(page.locator('#keyboard-navigation-runs-source-heading')).toHaveText('Runs Source');
  await expect(page.locator('#keyboard-navigation-outcomes-source-heading')).toHaveText('Outcomes Source');

  await sections.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(sections.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(sections.nth(0)).toBeFocused();
});

test('repository page template follows its JSON-declared hash query route in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const dashboardDocument = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.goto('http://dashboard.test/#page-repository-workflow-inventory?repository=octo-org%2Focto-repo');
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      const dashboardDocument = ${JSON.stringify(dashboardDocument)};
      const metadata = {
        'source-id': 'workflows-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-30T08:00:00Z',
        'retrieved-at': '2026-08-30T08:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [
            { organization: 'octo-org', repository: 'octo-repo', workflow: 'review.md', 'workflow-name': 'Review', 'workflow-active': 'true', runs: 2, aic: 3 },
            { organization: 'octo-org', repository: 'octo-repo', workflow: 'triage.md', 'workflow-name': 'Triage', 'workflow-active': 'true', runs: 4, aic: 5 },
            { organization: 'other-org', repository: 'other-repo', workflow: 'other.md', 'workflow-name': 'Other', 'workflow-active': 'true', runs: 1, aic: 1 }
          ]
        },
        repositories: {
          source: 'repositories',
          metadata,
          rows: [
            { organization: 'octo-org', repository: 'octo-repo', 'rollout-mode': 'review', 'observed-at': '2026-08-30T08:00:00Z' },
            { organization: 'other-org', repository: 'other-repo', 'rollout-mode': 'review', 'observed-at': '2026-08-30T08:00:00Z' }
          ]
        },
        runs: { source: 'runs', metadata, rows: [] },
        outcomes: { source: 'outcomes', metadata, rows: [] },
        audits: { source: 'audits', metadata, rows: [] },
        'operational-graders': { source: 'operational-graders', metadata, rows: [] }
      };
      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        dashboardDocument,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      const viewSources = await loadPageSources('repository-workflow-inventory', {
        routeParameters: { repository: 'octo-org/octo-repo' }
      });
      document.querySelector('#root').append(renderDashboard({
        document: dashboardDocument,
        sources: viewSources,
        loadPageSources
      }));
    </script>
  `);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('octo-org/octo-repo');
  await expect(page.getByRole('navigation', { name: 'octo-org/octo-repo views' })
    .getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
  const repositoryTable = page.locator('[data-page-id="repository-workflow-inventory"] .custom-table');
  await expect(repositoryTable).toContainText('Review');
  await expect(repositoryTable).toContainText('Triage');
  await expect(repositoryTable).not.toContainText('Other');

  await page.evaluate(() => {
    window.location.hash = '#page-repository-workflow-inventory?repository=other-org%2Fother-repo';
  });

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('other-org/other-repo');
  await expect(repositoryTable).toContainText('Other');
  await expect(repositoryTable).not.toContainText('Review');
});

test('workflow page template follows its JSON-declared route and renders attributed reports', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const workflowRoute = 'githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fambient-context.md';
  await page.goto(`http://dashboard.test/#page-workflow-detail?workflow=${workflowRoute}`);
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      const metadata = {
        'source-id': 'workflow-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-31T20:00:00Z',
        'retrieved-at': '2026-08-31T20:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflow-route',
          title: 'Central Agentic Ops',
          repository: 'githubnext/gh-aw-cao',
          pages: [
            {
              id: 'repositories',
              kind: 'custom',
              title: 'Repositories',
              views: []
            },
            {
              id: 'repository-detail',
              kind: 'custom',
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository' },
              views: []
            },
            {
              id: 'workflow-runtime',
              kind: 'custom',
              title: 'Workflow runtime',
              route: { 'hash-query-parameter': 'workflow' },
              views: []
            },
            {
              id: 'workflow-runs',
              kind: 'custom',
              title: 'Workflow runs',
              route: { 'hash-query-parameter': 'workflow' },
              views: [
                {
                  id: 'workflow-runs-route',
                  title: 'Workflow runs',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'workflow-route-page',
                  config: { body: 'runs' }
                },
                {
                  id: 'workflow-runs-table',
                  title: 'Runs',
                  data: { source: 'workflow-runs', 'route-field': 'workflow-route' },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    columns: [
                      { field: 'run', type: 'nominal', title: 'Run' },
                      { field: 'run-title', type: 'nominal', title: 'Title' },
                      { field: 'run-status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'run-conclusion', type: 'nominal', title: 'Conclusion', display: 'status' },
                      { field: 'event', type: 'nominal', title: 'Trigger' },
                      { field: 'started-at', type: 'temporal', title: 'Started' }
                    ],
                    href: { field: 'run-link', type: 'nominal' }
                  }
                }
              ]
            },
            {
              id: 'workflow-detail',
              kind: 'custom',
              title: 'Workflow',
              description: 'Workflow reports.',
              route: { 'hash-query-parameter': 'workflow' },
              views: [
                {
                  id: 'workflow-reports-route',
                  title: 'Workflow reports',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'workflow-route-page',
                  config: { body: 'reports' }
                },
                {
                  id: 'workflow-report-table',
                  title: 'Reports',
                  data: { source: 'workflow-reports', 'route-field': 'workflow-route' },
                  mark: 'table',
                  encoding: {
                    columns: [
                      { field: 'outcome-title', type: 'nominal', title: 'Report', display: 'outcome-link' },
                      { field: 'outcome-status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'rollout-mode', type: 'nominal', title: 'Mode', display: 'mode' },
                      { field: 'outcome-category', type: 'nominal', title: 'Type' },
                      { field: 'observed-at', type: 'temporal', title: 'Updated' }
                    ]
                  }
                }
              ]
            },
            {
              id: 'outcome-detail',
              kind: 'custom',
              title: 'Outcome',
              route: { 'hash-query-parameter': 'outcome' },
              views: [{
                id: 'outcome-record',
                title: 'Outcome',
                data: { sources: ['outcomes'] },
                mark: 'element',
                element: 'outcome-detail'
              }]
            }
          ]
        }
      };
      const sources = {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            campaign: 'ambient-context',
            'campaign-name': 'Ambient Context',
            workflow: '.github/workflows/ambient-context.md',
            'workflow-name': 'Ambient Context',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review'
          }]
        },
        'workflow-reports': {
          source: 'workflow-reports',
          metadata,
          rows: [{
            organization: 'customer',
            repository: 'target',
            'runtime-repository': 'githubnext/gh-aw-cao',
            'workflow-route': 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md',
            workflow: '.github/workflows/ambient-context.md',
            'workflow-name': 'Ambient Context',
            'safe-output': 'report-1',
            'outcome-title': 'Debug ambient context workflow failure',
            'outcome-summary': 'Investigated the reported workflow failure.',
            'outcome-category': 'pull-request',
            'outcome-status': 'closed',
            'rollout-mode': 'review',
            'observed-at': '2026-08-31T19:00:00Z'
          }]
        },
        'workflow-runs': {
          source: 'workflow-runs',
          metadata,
          rows: [
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/ambient-context.md',
              'workflow-route': 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md',
              run: '102',
              'run-title': 'Scheduled review',
              event: 'schedule',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'started-at': '2026-08-31T20:00:00Z',
              'run-link': {
                relation: 'run',
                href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/102',
                label: 'View run 102'
              }
            },
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/ambient-context.md',
              'workflow-route': 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md',
              run: '101',
              'run-title': 'Manual review',
              event: 'workflow_dispatch',
              'run-status': 'completed',
              'run-conclusion': 'failure',
              'started-at': '2026-08-31T19:00:00Z'
            }
          ]
        }
      };
      const loadPageSources = (pageId, options) => prepareDashboardViewSources(
        dashboardDocument,
        pageId,
        sources,
        { queryContext: options.queryContext, routeParameters: options.routeParameters }
      );
      const routeParameters = {
        workflow: 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md'
      };
      const viewSources = await loadPageSources('workflow-detail', { routeParameters });
      document.querySelector('#root').append(renderDashboard({
        document: dashboardDocument,
        sources: viewSources,
        loadPageSources
      }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Ambient Context', level: 1 })).toBeVisible();
  await expect(page.locator('#page-workflow-detail .custom-table')).toContainText('Debug ambient context workflow failure');
  await expect(page.locator('#page-workflow-detail .custom-table .status-success')).toHaveText('closed');
  await expect(page.locator('#page-workflow-detail .custom-table .mode-review')).toHaveText('review');
  await page.goto(`http://dashboard.test/#page-workflow-detail?workflow=${workflowRoute}`);
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const metadata = {
        'source-id': 'workflow-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-31T20:00:00Z',
        'retrieved-at': '2026-08-31T20:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflow-route',
          title: 'Central Agentic Ops',
          repository: 'githubnext/gh-aw-cao',
          pages: [
            {
              id: 'repositories',
              kind: 'custom',
              title: 'Repositories',
              views: []
            },
            {
              id: 'repository-detail',
              kind: 'custom',
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository' },
              views: []
            },
            {
              id: 'workflow-runtime',
              kind: 'custom',
              title: 'Workflow runtime',
              route: { 'hash-query-parameter': 'workflow' },
              views: []
            },
            {
              id: 'workflow-runs',
              kind: 'custom',
              title: 'Workflow runs',
              route: { 'hash-query-parameter': 'workflow' },
              views: [
                {
                  id: 'workflow-runs-route',
                  title: 'Workflow runs',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'workflow-route-page',
                  config: { body: 'runs' }
                },
                {
                  id: 'workflow-runs-table',
                  title: 'Runs',
                  data: { source: 'workflow-runs', 'route-field': 'workflow-route' },
                  mark: 'table',
                  controls: 'interactive',
                  encoding: {
                    columns: [
                      { field: 'run', type: 'nominal', title: 'Run' },
                      { field: 'run-title', type: 'nominal', title: 'Title' },
                      { field: 'run-status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'run-conclusion', type: 'nominal', title: 'Conclusion', display: 'status' },
                      { field: 'event', type: 'nominal', title: 'Trigger' },
                      { field: 'started-at', type: 'temporal', title: 'Started' }
                    ],
                    href: { field: 'run-link', type: 'nominal' }
                  }
                }
              ]
            },
            {
              id: 'workflow-detail',
              kind: 'custom',
              title: 'Workflow',
              description: 'Workflow reports.',
              route: { 'hash-query-parameter': 'workflow' },
              views: [
                {
                  id: 'workflow-reports-route',
                  title: 'Workflow reports',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'workflow-route-page',
                  config: { body: 'reports' }
                },
                {
                  id: 'workflow-report-table',
                  title: 'Reports',
                  data: { source: 'workflow-reports', 'route-field': 'workflow-route' },
                  mark: 'table',
                  encoding: {
                    columns: [
                      { field: 'outcome-title', type: 'nominal', title: 'Report', display: 'outcome-link' },
                      { field: 'outcome-status', type: 'nominal', title: 'Status', display: 'status' },
                      { field: 'rollout-mode', type: 'nominal', title: 'Mode', display: 'mode' },
                      { field: 'outcome-category', type: 'nominal', title: 'Type' },
                      { field: 'observed-at', type: 'temporal', title: 'Updated' }
                    ]
                  }
                }
              ]
            },
            {
              id: 'outcome-detail',
              kind: 'custom',
              title: 'Outcome',
              route: { 'hash-query-parameter': 'outcome' },
              views: [{
                id: 'outcome-record',
                title: 'Outcome',
                data: { sources: ['outcomes'] },
                mark: 'element',
                element: 'outcome-detail'
              }]
            }
          ]
        }
      };
      const sources = {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            campaign: 'ambient-context',
            'campaign-name': 'Ambient Context',
            workflow: '.github/workflows/ambient-context.md',
            'workflow-name': 'Ambient Context',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review'
          }]
        },
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [{
            organization: 'customer',
            repository: 'target',
            'runtime-repository': 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/ambient-context.md',
            'workflow-name': 'Ambient Context',
            'safe-output': 'report-1',
            'outcome-title': 'Debug ambient context workflow failure',
            'outcome-summary': 'Investigated the reported workflow failure.',
            'outcome-category': 'pull-request',
            'outcome-status': 'closed',
            'rollout-mode': 'review',
            'observed-at': '2026-08-31T19:00:00Z'
          }]
        },
        runs: {
          source: 'runs',
          metadata,
          rows: [
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/ambient-context.md',
              run: '102',
              'run-title': 'Scheduled review',
              event: 'schedule',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'started-at': '2026-08-31T20:00:00Z',
              'run-link': {
                relation: 'run',
                href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/102',
                label: 'View run 102'
              }
            },
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/ambient-context.md',
              run: '101',
              'run-title': 'Manual review',
              event: 'workflow_dispatch',
              'run-status': 'completed',
              'run-conclusion': 'failure',
              'started-at': '2026-08-31T19:00:00Z'
            }
          ]
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);
});

test('workflow runtime route renders JSON-declared workflow insights', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.goto('http://dashboard.test/#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md');
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { prepareDashboardViewSources } from 'http://dashboard.test/test/e2e/helpers/dashboard-view-sources.js';
      const metadata = {
        'source-id': 'workflow-runtime-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-31T19:00:00Z',
        'retrieved-at': '2026-08-31T19:01:00Z',
        'coverage-start': '2026-08-30T19:00:00Z',
        'coverage-end': '2026-08-31T19:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const workflow = '.github/workflows/multi-device-docs-tester.md';
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflow-runtime-route',
          title: 'Workflow runtime route',
          repository: 'githubnext/gh-aw-cao',
          pages: [{
            id: 'workflow-runtime',
            kind: 'custom',
            title: 'Workflow runtime',
            route: { 'hash-query-parameter': 'workflow' },
            views: [{
              id: 'workflow-runtime-route',
              title: 'Workflow runtime',
              data: { sources: ['workflows', 'runs', 'usage', 'operational-graders'] },
              mark: 'element',
              element: 'workflow-route-page',
              config: { body: 'insights' }
            }]
          }]
        }
      };
      const sources = {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow,
            'workflow-name': 'Multi-Device Docs Tester',
            'workflow-role': 'standalone',
            campaign: 'testing',
            'campaign-name': 'Testing',
            'campaign-memberships': [
              { id: 'testing', name: 'Testing' },
              { id: 'central-agentic-ops', name: 'Central Agentic Ops' }
            ],
            'workflow-active': 'true',
            'rollout-mode': 'review',
            'workflow-link': {
              relation: 'workflow',
              href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md',
              label: 'View authored workflow'
            }
          }]
        },
        runs: {
          source: 'runs',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow,
            run: '45',
            'run-status': 'completed',
            'run-conclusion': 'success'
          }]
        },
        usage: {
          source: 'usage',
          metadata: { ...metadata, completeness: 'partial' },
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow,
            run: '45',
            aic: 962.7
          }]
        },
        'operational-graders': {
          source: 'operational-graders',
          metadata,
          rows: []
        }
      };
      const routeParameters = {
        workflow: 'githubnext/gh-aw-cao:.github/workflows/multi-device-docs-tester.md'
      };
      const viewSources = await prepareDashboardViewSources(
        dashboardDocument,
        'workflow-runtime',
        sources,
        { routeParameters }
      );
      document.querySelector('#root').append(renderDashboard({
        document: dashboardDocument,
        sources: viewSources
      }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Multi-Device Docs Tester', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Multi-Device Docs Tester views' })).toContainText('InsightsReportsRuns');
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', /#page-workflow-detail\?workflow=/);
  await expect(page.locator('.workflow-badges .workflow-badge')).toHaveText([
    'Standalone',
    'Campaign · Central Agentic Ops',
    'Campaign · Testing'
  ]);
  await expect(page.getByRole('link', { name: 'View authored workflow' })).toHaveAttribute(
    'href',
    'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md'
  );
  await expect(page.locator('.workflow-runtime-metrics')).toContainText('1');
  await expect(page.locator('.workflow-runtime-metrics')).toContainText('962.7');
  await expect(page.getByRole('heading', { name: 'No workflow observations yet' })).toBeVisible();
});

test('outcome page template follows its JSON-declared hash query route in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.goto('about:blank#page-outcome-detail?outcome=outcome-1');
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const metadata = {
        'source-id': 'outcomes-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-31T08:00:00Z',
        'retrieved-at': '2026-08-31T08:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'outcome-route',
          title: 'Outcome route',
          pages: [{
            id: 'outcome-detail',
            kind: 'custom',
            title: 'Outcome',
            description: 'Outcome details.',
            'filter-bar': true,
            route: { 'hash-query-parameter': 'outcome' },
            views: [{
              id: 'outcome-record',
              title: 'Outcome',
              data: { sources: ['outcomes'] },
              'title-link': { 'href-field': 'external-link', 'identifier-field': 'outcome-number' },
              mark: 'element',
              element: 'outcome-detail'
            }]
          }]
        }
      };
      const sources = {
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [{
            workflow: '.github/workflows/daily.md',
            'workflow-name': 'Daily review',
            'safe-output': 'outcome-1',
            'outcome-number': 403,
            'outcome-title': 'Parity verification sweep',
            'outcome-body-html': '<h2>Summary</h2><p>All checks passed.</p>',
            'outcome-category': 'pull-request',
            'outcome-status': 'closed',
            'outcome-state': 'lifecycle-close',
            'rollout-mode': 'live',
            'published-at': '2026-08-31T01:26:00Z',
            'observed-at': '2026-08-31T01:49:00Z',
            'external-link': {
              relation: 'external',
              href: 'https://github.com/githubnext/gh-aw-cao/issues/403',
              label: 'View output'
            }
          }]
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Parity verification sweep');
  await expect(page.locator('[data-page-title-link]')).toHaveText('#403');
  await expect(page.locator('[data-page-title-link]')).toHaveAttribute('href', 'https://github.com/githubnext/gh-aw-cao/issues/403');
  await expect(page.locator('.overview-header [data-page-description]')).toHaveText('Daily review · Pull Request · Closed');
  await page.locator('.horizon-toggle').click();
  await expect(page.getByRole('searchbox', { name: 'Current filters' })).toHaveValue('');
  await expect(page.locator('.outcome-detail')).toHaveAttribute('data-outcome', 'outcome-1');
  await expect(page.locator('.discussion-post')).toContainText('All checks passed.');
  await expect(page.locator('.outcome-meta')).toContainText('Live');
  await expect(page.locator('.discussion-post')).toHaveCount(1);
  await expect(page.locator('.outcome-meta')).toHaveCount(1);
});

test('declarative tables expose report-style facets and progressive catalog disclosure', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const rows = Array.from({ length: 30 }, (_, index) => ({
        workflow: \`workflow-\${index + 1}\`,
        'rollout-mode': index % 2 === 0 ? 'review' : 'live'
      }));
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'catalog-dashboard',
            title: 'Catalog Dashboard',
            pages: [{
              id: 'catalog',
              kind: 'custom',
              title: 'Catalog',
              views: [{
                id: 'workflow-catalog',
                title: 'Workflow catalog',
                data: { source: 'workflows' },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'workflow', type: 'nominal' },
                    { field: 'rollout-mode', type: 'nominal', title: 'Mode' }
                  ]
                }
              }]
            }]
          }
        },
        sources: {
          workflows: {
            source: 'workflows',
            rows,
            metadata: {
              'source-id': 'workflow-catalog-fixture',
              'source-kind': 'fixture',
              'as-of': '2026-08-30T20:00:00Z',
              'retrieved-at': '2026-08-30T20:01:00Z',
              completeness: 'complete',
              freshness: 'fresh',
              availability: 'available'
            }
          }
        }
      }));
    </script>
  `);

  const tableRows = page.locator('.custom-table tbody tr');
  const visibleRows = page.locator('.custom-table tbody tr:visible');
  await expect(tableRows).toHaveCount(30);
  await expect(visibleRows).toHaveCount(25);
  await expect(page.locator('.table-filter-result')).toHaveText('Showing 25 of 30 results');
  const tableLayout = await page.locator('.custom-table').evaluate((table) => {
    const scroll = table.closest('.table-scroll');
    const cells = table.querySelectorAll('thead tr:first-child th');
    return {
      tableWidth: table.getBoundingClientRect().width,
      scrollWidth: scroll?.getBoundingClientRect().width ?? 0,
      firstColumnWidth: cells[0]?.getBoundingClientRect().width,
      lastColumnWidth: cells[cells.length - 1]?.getBoundingClientRect().width,
      lastColumnAlignment: getComputedStyle(cells[cells.length - 1]).textAlign
    };
  });
  expect(tableLayout.tableWidth).toBeCloseTo(tableLayout.scrollWidth, 0);
  expect(tableLayout.lastColumnWidth).toBeGreaterThan(tableLayout.firstColumnWidth);
  expect(tableLayout.lastColumnAlignment).toBe('left');
  await expect(page.locator('thead th').filter({ has: page.locator('[data-table-facet="rollout-mode"]') })).toHaveCount(1);
  const modeFilter = page.getByRole('combobox', { name: 'Filter by Mode' });
  await expect(modeFilter).toHaveValue('');
  await expect(modeFilter).toHaveCSS('appearance', 'none');
  await expect(modeFilter.locator('..')).toHaveCSS('border-radius', '999px');

  await page.getByRole('button', { name: 'Show all rows' }).click();
  await expect(visibleRows).toHaveCount(30);
  await expect(page.locator('.table-region')).toHaveClass(/table-region-expanded/);
  await expect(page.locator('.table-scroll')).toHaveCSS('max-height', 'none');
  await expect(page.locator('.table-scroll')).toHaveCSS('overflow', 'visible');

  await page.locator('[data-table-facet="rollout-mode"]').selectOption('review');
  await expect(visibleRows).toHaveCount(15);
  await expect(page.locator('.table-filter-result')).toHaveText('Showing 15 of 15 results');
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('workflow-catalog.rollout-mode=review');

  await page.getByRole('searchbox', { name: 'Filter Workflow catalog' }).fill('workflow-29');
  await expect(visibleRows).toHaveCount(1);
  await expect(visibleRows).toContainText('workflow-29');
  await expect(page.locator('.table-filter-result')).toHaveText('Showing 1 of 1 result');
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('workflow-catalog.q=workflow-29');
});

test('DLS-SAFE-004 runtime links with embedded credentials, ftp schemes, and blank labels are not exposed in browser output', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'credential-link-dashboard',
          title: 'Credential Link Dashboard',
          pages: [{
            id: 'credential-links',
            kind: 'custom',
            title: 'Credential Links',
            views: [
              {
                id: 'credential-links-table',
                title: 'Credential Links Table',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              },
              {
                id: 'credential-links-metric',
                title: 'Credential Links Metric',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: {
                  value: { field: 'run', type: 'nominal', aggregate: 'count' },
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      };

      const sources = {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-link': { href: 'https://user:secret@example.com/runs/1', label: 'Credentialed Run' } },
            { run: '2', 'run-link': { href: 'ftp://example.com/runs/2', label: 'FTP Run' } },
            { run: '3', 'run-link': { href: 'https://example.com/runs/3', label: '   ' } },
            { run: '4', 'run-link': { href: 'https://example.com/runs/4', label: 'Run 4' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Credential Links', level: 1 })).toBeVisible();
  await expect(page.locator('.custom-table a')).toHaveText('4');
  await expect(page.locator('.metric-link a')).toHaveText('Run 4');
  await expect(page.locator('a[href*="user:secret@"]').first()).toHaveCount(0);
  await expect(page.locator('a[href^="ftp:"]').first()).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Credentialed Run');
  await expect(page.locator('body')).not.toContainText('FTP Run');
});

test('desktop navigation collapses to an icon rail and expands back to text', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 1200, height: 800 });
  const dashboardContent = `
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'sidebar-toggle-dashboard',
            title: 'Sidebar Toggle',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `;
  await page.setContent(dashboardContent);

  const toggle = page.getByRole('button', { name: 'Collapse navigation' });
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
  await toggle.click();

  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '64px');
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.nav-label').first()).toBeHidden();
  await expect(page.locator('.sidebar-brand')).toBeHidden();

  await page.reload();
  await page.setContent(dashboardContent);
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);

  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.nav-label').first()).toBeVisible();
  await expect(page.locator('.sidebar-brand')).toBeVisible();

  await page.reload();
  await page.setContent(dashboardContent);
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);

  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
});

test('phone navigation keeps all views in the full-label menu without horizontal scrolling', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-navigation-dashboard',
            title: 'Phone Navigation',
            repository: 'githubnext/gh-aw-cao',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] },
              { id: 'security', kind: 'custom', title: 'Security', icon: 'shield', views: [] },
              { id: 'value', kind: 'custom', title: 'Value', icon: 'graph', views: [] },
              { id: 'cost', kind: 'custom', title: 'Cost & efficiency', icon: 'meter', views: [] },
              { id: 'campaigns', kind: 'custom', title: 'Campaigns', icon: 'goal', views: [] }
            ],
            navigation: [
              { label: 'Main', pages: ['overview', 'runs', 'security'] },
              { label: 'Investigate', pages: ['value', 'cost', 'campaigns'] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `);

  const historyBack = page.getByRole('button', { name: 'Go back' });
  await expect(historyBack).toBeHidden();
  const mobileBrandName = page.locator('.mobile-page-header .mobile-brand-name');
  await expect(mobileBrandName).toBeVisible();
  await expect(mobileBrandName).toHaveText('gh-aw-cao');
  expect(await page.evaluate(() => {
    const title = document.querySelector('.mobile-page-header #page-title');
    const brand = document.querySelector('.mobile-page-header .mobile-brand-name');
    if (!title || !brand) return false;
    return brand.getBoundingClientRect().top >= title.getBoundingClientRect().bottom;
  })).toBe(true);
  await expect(page.locator('.primary-nav')).toBeHidden();

  const viewMenuButton = page.getByRole('button', { name: 'Select view' });
  await expect(viewMenuButton).toHaveCSS('border-radius', '50%');
  await expect(viewMenuButton).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await viewMenuButton.click();
  const menu = page.locator('.mobile-nav-menu-list');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mobile-nav-item')).toHaveCount(6);
  await expect(menu.getByText('Overview', { exact: true })).toBeVisible();
  await expect(menu.getByText('Runs', { exact: true })).toBeVisible();
  const menuActions = page.locator('.mobile-nav-menu-actions');
  await expect(menuActions.locator('.theme-control .action-label')).toBeVisible();
  await expect(menuActions.locator('.theme-control .action-label')).toHaveText('Appearance');
  await expect(menuActions.locator('.repository-link .action-label')).toBeVisible();
  await expect(menuActions.locator('.repository-link .action-label')).toHaveText('githubnext/gh-aw-cao');
  await expect(menuActions.locator('.account-menu')).toHaveCount(0);
  await expect(menu.locator('.octicon-goal')).toBeVisible();
  await expect(menu.getByText('Cost & efficiency', { exact: true })).toBeVisible();
  await menu.getByText('Cost & efficiency', { exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Cost & efficiency', level: 1 })).toBeVisible();
  await expect(page.locator('.primary-nav')).toHaveCSS('display', 'none');
  await expect(historyBack).toBeVisible();
  await expect(historyBack).toHaveCSS('border-radius', '50%');
  await expect(historyBack).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await historyBack.click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(historyBack).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('phone pages toggle between chart, full-view table, and card-list modes', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-view-mode-dashboard',
            title: 'Phone View Mode',
            pages: [{
              id: 'runs',
              kind: 'custom',
              title: 'Runs',
              views: [
                {
                  id: 'runs-chart',
                  title: 'Run trend',
                  data: { source: 'runs' },
                  mark: 'chart',
                  chart: 'line',
                  encoding: {
                    x: { field: 'started-at', type: 'temporal' },
                    y: { field: 'run-count', type: 'quantitative' }
                  }
                },
                {
                  id: 'runs-table',
                  title: 'Runs',
                  data: { source: 'runs' },
                  mark: 'table',
                  controls: 'interactive',
                  'lazy-list': true,
                  layout: 'full-view',
                  encoding: { columns: [{ field: 'run', title: 'Run' }] }
                }
              ]
            }]
          }
        },
        sources: {
          runs: {
            source: 'runs',
            rows: [{ run: '1', 'run-count': 1, 'started-at': '2026-09-16T10:00:00Z' }],
            metadata: {
              availability: 'available',
              completeness: 'complete',
              freshness: 'fresh'
            }
          }
        }
      }));
    </script>
  `);

  const root = page.locator('.dashboard-root');
  const chart = page.locator('[data-view-id="runs-chart"]');
  const table = page.locator('[data-view-id="runs-table"]');
  const viewModeToggle = page.locator('.mobile-view-mode-toggle');
  await expect(page.locator('[data-page-id="runs"] > .page-chrome > .filter-bar')).toBeHidden();
  await expect(viewModeToggle).toBeVisible();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Cards view');
  await expect(viewModeToggle.locator('.octicon-graph')).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(table).toBeHidden();
  await expect(root).not.toHaveClass(/dashboard-full-view/);

  await viewModeToggle.click();

  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Table view');
  await expect(viewModeToggle.locator('.octicon-stack')).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(table).toBeVisible();
  await expect(table.locator('.table-region')).toBeHidden();
  await expect(table.locator('[data-mobile-card-list]')).toBeVisible();
  await expect(root).toHaveClass(/dashboard-full-view/);

  await viewModeToggle.click();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Chart view');
  await expect(viewModeToggle.locator('.octicon-table')).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(table.locator('.table-region')).toBeVisible();
  await expect(table.locator('[data-mobile-card-list]')).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);
  await expect(table.getByRole('heading', { name: 'Runs', level: 3 })).toBeHidden();
  await expect(page.locator('[data-page-id="runs"] [data-view-mode-value="table"]')).toHaveAttribute('aria-pressed', 'true');
});

test('phone Workflows page cycles through chart, table, and card-list views', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workflowsPage = builtInPage('workflows');
  await page.evaluate(async ({ presenterModuleUrl, workflowsPage }) => {
    window.location.hash = '#page-workflows';
    const { renderDashboard } = await import(presenterModuleUrl);
    document.querySelector('#root')?.append(renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflows-view-mode-dashboard',
          title: 'Workflows View Mode',
          pages: [workflowsPage]
        }
      },
      sources: {
        'workflow-aic-per-run': {
          source: 'workflow-aic-per-run',
          rows: [{
            'campaign-name': 'Maintenance',
            repository: 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/aw-maintenance.md',
            'workflow-name': 'AW Maintenance',
            'workflow-label': 'githubnext/gh-aw-cao:.github/workflows/aw-maintenance.md',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review',
            'workflow-active': 'active',
            aic: 12,
            runs: 4,
            'aic-per-run': 3,
            ingestion: '100%',
            'workflow-link': { relation: 'workflow', href: '#page-workflow-runtime', label: 'View AW Maintenance' },
            'repository-link': { relation: 'repository', href: '#page-repository-detail', label: 'View githubnext/gh-aw-cao' }
          }],
          metadata: {
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        },
        'workflow-inventory': {
          source: 'workflow-inventory',
          rows: [{
            'campaign-name': 'Maintenance',
            repository: 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/aw-maintenance.md',
            'workflow-name': 'AW Maintenance',
            'workflow-label': 'githubnext/gh-aw-cao:.github/workflows/aw-maintenance.md',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review',
            'workflow-active': 'active',
            aic: 12,
            runs: 4,
            'aic-per-run': 3,
            ingestion: '100%',
            'workflow-link': { relation: 'workflow', href: '#page-workflow-runtime', label: 'View AW Maintenance' },
            'repository-link': { relation: 'repository', href: '#page-repository-detail', label: 'View githubnext/gh-aw-cao' }
          }],
          metadata: {
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    }));
  }, { presenterModuleUrl: buildPresenterModuleUrl(), workflowsPage });

  const chart = page.locator('[data-view-id="workflows-by-aic-per-run"]');
  const table = page.locator('[data-view-id="workflows-inventory"]');
  const viewModeToggle = page.locator('.mobile-view-mode-toggle');
  await expect(chart).toBeVisible();
  await expect(table).toBeHidden();

  await expect(page.locator('[data-page-id="workflows"] > .page-chrome > .filter-bar')).toBeHidden();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Cards view');
  await viewModeToggle.click();
  await expect(chart).toBeHidden();
  await expect(table.locator('.table-region')).toBeHidden();
  await expect(table.locator('[data-mobile-card-list]')).toContainText('AW Maintenance');

  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Table view');
  await viewModeToggle.click();
  await expect(table.locator('.table-region')).toBeVisible();
  await expect(table.locator('tbody')).toContainText('AW Maintenance');
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Chart view');
});

test('phone full-view lazy tables switch between table and card-list modes', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-table-card-dashboard',
            title: 'Phone Table Cards',
            'card-templates': [{
              id: 'repository',
              icon: 'repo',
              title: { field: 'repository-coordinate' },
              labels: [],
              details: [{ field: 'organization', title: 'Organization' }]
            }],
            pages: [{
              id: 'repositories',
              kind: 'custom',
              title: 'Repositories',
              views: [{
                id: 'repositories-table',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                controls: 'interactive',
                'lazy-list': true,
                layout: 'full-view',
                encoding: {
                  columns: [
                    { field: 'repository-coordinate', type: 'nominal', title: 'Repository' },
                    { field: 'organization', type: 'nominal', title: 'Organization' }
                  ]
                }
              }]
            }]
          }
        },
        sources: {
          repositories: {
            source: 'repositories',
            rows: [{
              'repository-coordinate': 'githubnext/gh-aw-cao',
              organization: 'githubnext'
            }],
            metadata: {
              availability: 'available',
              completeness: 'complete',
              freshness: 'fresh'
            }
          }
        }
      }));
    </script>
  `);

  const root = page.locator('.dashboard-root');
  const table = page.locator('[data-view-id="repositories-table"] .table-region');
  const cards = page.locator('[data-mobile-card-list]');
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);

  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(table).toBeHidden();
  await expect(cards).toBeVisible();
  await expect(cards.locator('.entity-card-list-card')).toContainText('githubnext/gh-aw-cao');
  await expect(root).toHaveClass(/dashboard-full-view/);
  await expect(page.getByRole('heading', { name: 'Repositories', level: 3 })).toBeHidden();

  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);
});
