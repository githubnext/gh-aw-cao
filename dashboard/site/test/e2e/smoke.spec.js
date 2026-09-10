import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));

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

test('mobile Catch Up completes with persistent Done, Later, Open, and Notifications routing', async ({ page }) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderNotificationsInbox } from ${JSON.stringify('http://dashboard.test/src/components/notifications-inbox.js')};
      const rows = [
        {
          'attention-signal-id': 'later-story',
          'age-seconds': 60,
          'consequence-tier': 'high',
          'expected-actor': 'operator',
          'signal-type': 'runtime-failure',
          objective: 'Investigate mobile failure',
          reason: 'The mobile workflow failed.',
          scope: 'githubnext/mobile',
          'evidence-link': {
            href: 'https://github.com/githubnext/mobile/actions/runs/42',
            label: 'View run'
          }
        },
        {
          'attention-signal-id': 'done-story',
          'age-seconds': 120,
          'consequence-tier': 'high',
          'expected-actor': 'operator',
          'signal-type': 'agent-smell',
          objective: 'Review mobile agent',
          reason: 'Strict mode is disabled.',
          scope: 'githubnext/mobile-agent',
          'evidence-link': {
            href: 'https://github.com/githubnext/mobile-agent/issues/43',
            label: 'View issue'
          }
        }
      ];
      window.catchUpRows = rows;
      window.renderCatchUp = () => {
        document.querySelector('#root').replaceChildren(renderNotificationsInbox(rows));
      };
      window.renderCatchUp();
    </script>
  `);

  const firstCard = page.locator('.home-catchup-mobile-card');
  await expect(firstCard).toContainText('Investigate mobile failure');
  await expect(firstCard.locator('.home-catchup-mobile-link'))
    .toHaveAttribute('href', 'https://github.com/githubnext/mobile/actions/runs/42');
  const beforeOpen = await page.evaluate(() => localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue'));
  await firstCard.locator('.home-catchup-mobile-link').evaluate((link) => {
    link.addEventListener('click', (event) => event.preventDefault(), { once: true });
    if (link instanceof HTMLElement) link.click();
  });
  expect(await page.evaluate(() => localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue'))).toBe(beforeOpen);

  await firstCard.getByRole('button', { name: 'Later Investigate mobile failure', exact: true })
    .evaluate((button) => {
      if (button instanceof HTMLElement) button.click();
    });
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}').later))
    .toHaveLength(1);
  await expect(firstCard).toContainText('Review mobile agent');
  await firstCard.getByRole('button', { name: 'Done Review mobile agent', exact: true })
    .evaluate((button) => {
      if (button instanceof HTMLElement) button.click();
    });
  await expect(page.locator('.home-catchup-mobile')).toContainText('✓ You are caught up');

  await page.locator('.home-catchup-mobile').getByRole('link', { name: 'View Later in Notifications' }).click();
  await expect(page.getByRole('searchbox', { name: 'Filter notifications' })).toHaveValue('is:later');
  await expect(page.locator('.notification-item')).toHaveCount(1);
  await expect(page.locator('.notification-item')).toContainText('Investigate mobile failure');
  await expect(page.locator('.notifications-main')).not.toContainText('Review mobile agent');

  await page.evaluate(() => {
    /** @type {{ renderCatchUp: () => void }} */ (/** @type {unknown} */ (window)).renderCatchUp();
  });
  await expect(page.locator('.home-catchup-mobile')).toContainText('✓ You are caught up');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.locator('.notification-item')).toHaveCount(1);
  await expect(page.locator('.notification-content'))
    .toHaveAttribute('href', 'https://github.com/githubnext/mobile/actions/runs/42');
});

test('production pages expose a responsive executive chart', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'mobile-summary-fixture',
        'source-kind': 'fixture',
        'retrieved-at': '2026-09-03T12:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'started-at': '2026-09-02T12:00:00Z', 'run-conclusion': 'success' },
            { run: '2', 'started-at': '2026-09-03T12:00:00Z', 'run-conclusion': 'failure' }
          ],
          metadata
        }
      };
      window.location.hash = '#page-operations';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const firstView = page.locator('[data-page-id="operations"] .custom-view').first();
  const chart = firstView.locator('[data-chart-widget="swimlane"]');
  await expect(chart).toBeVisible();
  const ticks = chart.locator('.swimlane-time-label');
  await expect(ticks).toHaveCount(4);
  await expect(ticks.first()).toBeVisible();
  await expect(ticks.last()).toBeVisible();
  await expect(chart.locator('.swimlane-label')).toHaveCount(5);
  const [chartBox, plotBox] = await Promise.all([
    chart.boundingBox(),
    chart.locator('svg').boundingBox()
  ]);
  expect(chartBox).not.toBeNull();
  expect(plotBox).not.toBeNull();
  expect(chartBox?.y).toBeGreaterThanOrEqual(0);
  expect(chartBox?.height).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1200, height: 844 });
  const [wideChartBox, widePlotBox] = await Promise.all([
    chart.boundingBox(),
    chart.locator('svg').boundingBox()
  ]);
  expect(wideChartBox).not.toBeNull();
  expect(widePlotBox).not.toBeNull();
  expect(widePlotBox?.width).toBeGreaterThan((wideChartBox?.width ?? 0) * 0.95);
});

test('GitHub API events table remains operable at desktop and narrow widths', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'github-api-event-viewport-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-04T12:00:00Z',
        'retrieved-at': '2026-09-04T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const row = {
        'observed-at': '2026-09-04T12:00:00Z',
        'event-type': 'github-api.response',
        'event-summary': 'GET /rate_limit',
        'event-status': '200',
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run: '1',
        'correlation-id': 'request-1'
      };
      const sources = {
        'github-api-events': {
          source: 'github-api-events',
          metadata,
          rows: [
            { ...row, 'observed-at': '2026-09-04T11:00:00Z', 'event-type': 'github-api.request', 'event-status': 'pending' },
            row
          ]
        }
      };
      window.location.hash = '#page-overview';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  await page.locator('.nav-section').filter({ hasText: 'Experimental' }).locator('summary').click();
  await page.locator('[data-nav-page-id="github-api"]').click();
  const apiPage = page.locator('[data-page-id="github-api"]');
  const observations = apiPage.locator('[data-view-layout="full-view"]');
  const table = observations.locator('[data-lazy-list]');
  const scroll = observations.locator('.table-scroll');
  await expect(table).toBeVisible();
  await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
  await expect(scroll.locator(':scope > .table-filter')).toBeVisible();
  await expect(observations.locator(':scope > .table-filter')).toHaveCount(0);
  await expect(apiPage.getByText('github-api.response', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => {
    const box = await table.boundingBox();
    return box !== null && box.width <= 1200;
  }).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table).toBeVisible();
  await expect.poll(async () => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(async () => scroll.locator(':scope > .table-filter').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => {
    const box = await table.boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
  await expect(apiPage.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  await expect(apiPage.locator('[data-lazy-list]')).toHaveCount(1);
});

test('Runs renders all observed runs as one responsive full-view interactive table', async ({ page }) => {
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
              workflow: '.github/workflows/aw-doctor.md',
              'rollout-mode': 'review',
              engine: 'copilot',
              'engine-version': '1.2.3',
              'requested-model': 'gpt-5',
              'resolved-model': 'gpt-5',
              'started-at': '2026-09-10T12:00:00Z',
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/2', label: 'Run 2' }
            },
            {
              run: '1',
              'run-status': 'completed',
              'run-conclusion': 'success',
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/aw-doctor.md',
              'rollout-mode': 'review',
              engine: 'copilot',
              'engine-version': '1.2.3',
              'requested-model': 'gpt-5',
              'resolved-model': 'gpt-5',
              'started-at': '2026-09-10T11:00:00Z',
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/1', label: 'Run 1' }
            }
          ]
        }
      };
      window.location.hash = '#page-runs';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const dashboardRoot = page.locator('.dashboard-root');
  const runsPage = page.locator('[data-page-id="runs"]');
  const view = runsPage.locator('[data-view-layout="full-view"]');
  const table = view.locator('[data-lazy-list]');
  const scroll = view.locator('.table-scroll');
  await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
  await expect(page.locator('[data-nav-page-id="runs"]')).toHaveAttribute('aria-current', 'page');
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view/);
  await expect(view).toHaveCount(1);
  await expect(table).toBeVisible();
  await expect(view.locator('[data-table-filter]')).toBeVisible();
  await expect(view.locator('.table-summary-row')).toBeVisible();
  await expect(view.locator('.custom-table tbody tr')).toHaveCount(2);
  await expect(view.locator('.custom-table tbody tr').first()).toContainText('2');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table).toBeVisible();
  await expect.poll(async () => scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(async () => scroll.locator(':scope > .table-filter').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test('full-view unavailable-data callout keeps responsive page margins', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const sources = {
        'github-api-events': {
          source: 'github-api-events',
          metadata: {
            'source-id': 'github-api-events-unavailable-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-04T12:00:00Z',
            'retrieved-at': '2026-09-04T12:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'unavailable'
          },
          rows: []
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  await page.locator('.nav-section').filter({ hasText: 'Experimental' }).locator('summary').click();
  await page.locator('[data-nav-page-id="github-api"]').click();
  const callout = page.locator('[data-page-id="github-api"] .view-state-card');
  await expect(callout).toBeVisible();
  await expect(callout).toHaveCSS('margin-left', '24px');
  await expect(callout).toHaveCSS('margin-right', '24px');

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(callout).toHaveCSS('margin-left', '14px');
  await expect(callout).toHaveCSS('margin-right', '14px');
});

test('Safe Outputs renders every retained outcome in one progressive full-view table', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'safe-output-usage-fixture',
        'source-kind': 'derived',
        'query-name': 'safe-output-usage',
        'as-of': '2026-09-10T05:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        'safe-output-usage': {
          source: 'safe-output-usage',
          metadata,
          rows: Array.from({ length: 60 }, (_, index) => ({
            'safe-output': \`output-\${index + 1}\`,
            'safe-output-kind': index % 2 === 0 ? 'create-issue' : 'create-pull-request',
            'outcome-title': \`Retained output \${index + 1}\`,
            'outcome-status': index % 2 === 0 ? 'open' : 'closed',
            'outcome-state': index % 2 === 0 ? 'accepted' : 'completed',
            workflow: '.github/workflows/daily.md',
            repository: 'gh-aw-cao',
            'rollout-mode': index % 2 === 0 ? 'review' : 'live',
            run: String(1000 + index),
            'published-at': '2026-09-10T04:00:00Z',
            'observed-at': '2026-09-10T05:00:00Z',
            'external-link': {
              href: \`https://example.com/outputs/\${index + 1}\`,
              label: \`Open retained output \${index + 1}\`
            }
          }))
        }
      };
      window.location.hash = '#page-safe-outputs';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const safeOutputsPage = page.locator('[data-page-id="safe-outputs"]');
  const view = safeOutputsPage.locator('[data-view-layout="full-view"]');
  await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
  await expect(view).toHaveCount(1);
  await expect(view.locator('[data-lazy-list]')).toHaveCount(1);
  await expect(view.locator('tbody tr:visible')).toHaveCount(25);
  await expect(view.getByRole('searchbox', { name: 'Filter Safe output usage' })).toBeVisible();
  await expect(view.locator('tbody a[href="https://example.com/outputs/1"]')).toBeVisible();
  await expect(view.locator('tbody tr').first()).toContainText('create-issue');
  await expect(view.locator('tbody tr').first()).toContainText('output-1');

  await view.getByRole('searchbox', { name: 'Filter Safe output usage' }).fill('Retained output 60');
  await expect(view.locator('tbody tr:visible')).toHaveCount(1);
  await expect(view.locator('tbody tr:visible')).toContainText('Retained output 60');
  await view.getByRole('searchbox', { name: 'Filter Safe output usage' }).fill('');
  await view.locator('[data-table-more]').click();
  await expect(view.locator('tbody tr')).toHaveCount(50);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  await expectTableFilterIsContained(view.locator('.table-scroll > .table-filter'));
});

test('control-plane readiness presents operational evidence in one lazy table', async ({ page }) => {
  /** @type {Error[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1003, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'readiness-fixture',
        'source-kind': 'fixture',
        'retrieved-at': '2026-09-03T12:00:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'inventory-ready': true },
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'workflow-active': 'true', 'inventory-ready': true }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', run: '42', 'run-title': 'Readiness smoke', workflow: '.github/workflows/daily.md', 'started-at': '2026-09-03T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure', 'failure-message': 'Smoke regression', 'run-link': 'https://example.com/runs/42' },
            { organization: 'githubnext', repository: 'gh-aw-cao', run: '43', 'run-title': 'Worker smoke', workflow: '.github/workflows/daily-worker.md', 'started-at': '2026-09-03T11:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure', 'failure-message': 'Worker regression', 'run-link': 'https://example.com/runs/43' },
            { organization: 'githubnext', repository: 'gh-aw-cao', run: '44', 'run-title': 'Current readiness', workflow: '.github/workflows/daily.md', 'started-at': '2026-09-03T11:50:00Z', 'run-status': 'completed', 'run-conclusion': 'success', 'run-link': 'https://example.com/runs/44' },
            { organization: 'githubnext', repository: 'gh-aw-cao', run: '45', 'run-title': 'Pending readiness', workflow: '.github/workflows/daily.md', 'started-at': '2026-09-03T11:55:00Z', 'run-status': 'in_progress', 'run-conclusion': null, 'run-link': 'https://example.com/runs/45' }
          ],
          metadata
        },
        findings: {
          source: 'findings',
          rows: [{ finding: 'warning-1', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'finding-kind': 'authored-warning', 'observed-at': '2026-09-03T11:15:00Z' }],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [{ 'safe-output': 'noop-1', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'outcome-category': 'noop', 'observed-at': '2026-09-03T11:30:00Z' }],
          metadata
        },
        'coverage-diagnostics': { source: 'coverage-diagnostics', rows: [], metadata }
      };
      window.location.hash = '#page-readiness';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);
  expect(pageErrors).toEqual([]);

  const readinessPage = page.locator('[data-page-id="readiness"]');
  await expect(readinessPage).toBeVisible();
  const horizonFilter = page.getByLabel('Dashboard filters');
  await horizonFilter.locator('.horizon-toggle').click();
  await expect(horizonFilter.getByRole('searchbox', { name: 'Current filters' })).toHaveValue('');
  await expect(horizonFilter.locator('.count-badge')).toHaveText('3');
  const readinessNavigation = page.locator('[data-nav-page-id="readiness"]');
  await expect(readinessNavigation).toHaveAttribute('aria-current', 'page');
  await expect(readinessNavigation.locator('svg')).toHaveCount(1);
  await expect(page.locator('.nav-section-label').filter({ hasText: 'Experimental' })).toBeVisible();
  await expect(readinessPage.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  await expect(readinessPage.locator('[data-lazy-list]')).toBeVisible();
  await expect(readinessPage.locator('.chart-view-pie')).toHaveCount(0);
  await expect(readinessPage).toContainText('Worker failures');
  await expect(readinessPage).toContainText('Worker warnings');
  await expect(readinessPage).toContainText('No-op reports');
  await expect(readinessPage).toContainText('1 failure observed.');

  const windowStart = horizonFilter.locator('[aria-label="Window start time"]');
  const windowStop = horizonFilter.locator('[aria-label="Window stop time"]');
  const [localStart, localStop] = await page.evaluate((values) => values.map((value) => {
    const instant = new Date(value);
    return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }), ['2026-09-03T11:40:00Z', '2026-09-03T12:00:00Z']);
  await windowStart.fill(localStart);
  await windowStop.fill(localStop);
  await expect(windowStart).toHaveValue(localStart);
  await expect(windowStop).toHaveValue(localStop);
  await horizonFilter.getByRole('button', { name: 'Apply' }).click();
  await expect(horizonFilter.locator('[aria-label="Time window"]')).toHaveValue('custom');
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('central-agentic-ops.dashboard.horizon-filter-settings') ?? '{}'
  ).range)).toBe('custom');
  await expect(readinessPage).not.toContainText('Smoke regression');
  await expect(readinessPage.locator('[data-lazy-list]')).toBeVisible();
  await horizonFilter.locator('.horizon-toggle').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(horizonFilter.locator('.time-window-control')).toBeHidden();
  await horizonFilter.locator('.horizon-toggle').click();
  await expect(horizonFilter.locator('.time-window-control')).toBeVisible();
  await expect(horizonFilter.locator('[aria-label="Window start time"]')).toBeVisible();
  await expect(horizonFilter.locator('[aria-label="Window stop time"]')).toBeVisible();
  expect(await readinessPage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('experiments query renders as one full-view declarative table', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      import { processDashboardQueries } from ${JSON.stringify('http://dashboard.test/src/data-processor.js')};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'experiments-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-05T12:00:00Z',
        'retrieved-at': '2026-09-05T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        experiments: {
          source: 'experiments',
          metadata,
          rows: [{
            organization: 'acme',
            repository: 'tools',
            workflow: 'triage-agent',
            experiment: 'routing-v3',
            'experiment-name': 'Tool routing v3',
            'control-variant': 'control',
            'candidate-variant': 'candidate',
            'primary-metric': 'quality',
            readiness: 'READY',
            decision: 'PROMOTE'
          }]
        },
        'experiment-assignments': {
          source: 'experiment-assignments',
          metadata,
          rows: [
            { experiment: 'routing-v3', run: '100', variant: 'control' },
            { experiment: 'routing-v3', run: '101', variant: 'candidate' }
          ]
        },
        graders: {
          source: 'graders',
          metadata,
          rows: [{ grader: 'quality', role: 'PRIMARY', direction: 'higher_is_better', unit: 'raw' }]
        },
        'grader-observations': {
          source: 'grader-observations',
          metadata,
          rows: [
            { experiment: 'routing-v3', run: '100', grader: 'quality', value: .72, status: 'complete', 'observed-at': '2026-09-04T10:00:00Z' },
            { experiment: 'routing-v3', run: '101', grader: 'quality', value: .81, status: 'complete', 'observed-at': '2026-09-05T10:00:00Z' }
          ]
        },
        evals: { source: 'evals', metadata, rows: [] },
        'eval-observations': { source: 'eval-observations', metadata, rows: [] },
        runs: { source: 'runs', metadata, rows: [{ run: '100' }, { run: '101' }] },
        outcomes: { source: 'outcomes', metadata, rows: [] },
        usage: { source: 'usage', metadata, rows: [] },
        'operational-values': { source: 'operational-values', metadata, rows: [] }
      };
      window.location.hash = '#page-experiments?experiment=routing-v3';
      const querySources = await processDashboardQueries(documentModel.dashboard.queries, sources);
      document.querySelector('#root').append(renderDashboard({
        document: documentModel,
        sources: { ...sources, ...querySources }
      }));
    </script>
  `);

  const experimentsPage = page.locator('[data-page-id="experiments"]');
  await expect(experimentsPage).toBeVisible();
  const experimentsView = experimentsPage.locator('[data-view-layout="full-view"]');
  await expect(page.locator('.dashboard-root')).toHaveClass(/dashboard-full-view/);
  await expect(experimentsView).toHaveCount(1);
  await expect(experimentsView.locator('[data-lazy-list]')).toHaveCount(1);
  await expect(experimentsView.getByRole('searchbox', { name: 'Filter Experiments' })).toBeVisible();
  await expect(experimentsView.getByRole('cell', { name: 'routing-v3' })).toBeVisible();
  await expect(experimentsPage.locator('.custom-view')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);
  expect(await page.locator('main.dashboard-prototype').evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  await expectTableFilterIsContained(experimentsView.locator('.table-scroll > .table-filter'));
  expect(await experimentsView.locator('.table-scroll').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
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
            'assignment-id': 'assignment:release-train-updater:74',
            'agent-name': 'Release train updater',
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
          rows: [{
            'safe-output': 'dependabot-review',
            'outcome-title': 'Dependabot review retained',
            repository: 'gh-aw',
            'outcome-state': 'accepted',
            'observed-at': '2026-08-29T09:40:00Z',
            'external-link': evidenceLink
          }],
          metadata
        },
        'operational-values': {
          source: 'operational-values',
          rows: [
            {
              'operational-value': 0.6,
              'operational-value-definition': 'accepted-outcome',
              'observed-at': '2026-08-01T09:45:00Z',
              'evidence-link': evidenceLink
            },
            {
              'operational-value': 0.8,
              'operational-value-definition': 'accepted-outcome',
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
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const cleanNavigation = page.locator('.primary-nav > [data-nav-page-id]');
  const experimental = page.locator('.nav-section').filter({ hasText: 'Experimental' });
  await expect(cleanNavigation).toHaveText(['Overview', 'Repositories', 'Workflows', 'Runs', 'Packages']);
  await expect(experimental.getByRole('link', { name: /Repositories|Workflows|Runs|Packages/ })).toHaveCount(0);
  await expect(cleanNavigation.first().locator('.octicon-home')).toBeVisible();
  const accountMenu = page.locator('.account-menu');
  await expect(accountMenu.locator('summary .octicon-gear')).toBeVisible();
  await accountMenu.locator('summary').click();
  await expect(accountMenu.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(accountMenu.getByRole('link', { name: 'Open the dashboard workflow on GitHub Actions' })).toBeVisible();
  await expect(accountMenu.getByRole('group', { name: 'Appearance' })).toBeVisible();
  await expect(accountMenu.getByRole('button', { name: 'Reset local data' })).toBeVisible();
  await accountMenu.getByRole('button', { name: 'Reset local data' }).click();
  const resetDialog = page.getByRole('dialog', { name: 'Reset dashboard confirmation' });
  await expect(resetDialog).toBeVisible();
  await expect(resetDialog).toContainText('This action cannot be undone.');
  await resetDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(resetDialog).not.toBeVisible();
  await expect(accountMenu.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dashboard-root')).not.toHaveAttribute('data-theme');
  await accountMenu.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('.dashboard-root')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('central-agentic-ops.dashboard.theme'))).toBe('light');
  await accountMenu.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#page-configuration$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
  await expect(accountMenu).not.toHaveAttribute('open', '');
  const headerHeight = await page.locator('.overview-header').evaluate((element) => element.getBoundingClientRect().height);
  const description = page.locator('.overview-header .lede');
  expect(await description.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  await expect(page.getByText('Dashboard Next', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Show experimental')).toHaveCount(0);
  await expect(experimental).toBeVisible();
  await expect(experimental).not.toHaveAttribute('open', '');
  await expect(experimental.getByRole('link', { name: 'Operational health' })).toBeHidden();
  await experimental.locator('summary').click();
  await expect(experimental.getByRole('link', { name: 'Operational health' })).toBeVisible();
  await experimental.getByRole('link', { name: 'Work', exact: true }).click();
  await expect(page).toHaveURL(/#page-work$/);

  const workPage = page.locator('[data-page-id="work"]');
  await expect(workPage.locator('.work-board')).toBeVisible();
  await expect(workPage.locator('.work-tasks, .work-roadmap')).toHaveCount(0);
  const workFilters = workPage.getByRole('search', { name: 'Work filters' });
  await expect(workFilters.getByRole('searchbox', { name: 'Filter work items' })).toBeVisible();
  await expect(workFilters.locator('.work-filter-count')).toHaveText('2 of 2');
  await workFilters.getByRole('searchbox', { name: 'Filter work items' }).fill('missing workflow');
  await expect(workPage).toContainText('No work items match the current filters.');
  await workFilters.getByRole('button', { name: 'Clear work filters' }).click();
  await expect(workPage.locator('.work-card')).toHaveCount(2);

  await workPage.getByRole('link', { name: 'Tasks' }).click();
  await expect(page).toHaveURL(/#page-work-tasks$/);
  const tasksPage = page.locator('[data-page-id="work-tasks"]');
  await expect(tasksPage.locator('.work-tasks')).toBeVisible();
  await expect(tasksPage.locator('.work-board, .work-roadmap')).toHaveCount(0);
  await expect(experimental.getByRole('link', { name: 'Work', exact: true })).toHaveAttribute('aria-current', 'page');

  await tasksPage.getByRole('link', { name: 'Roadmap' }).click();
  await expect(page).toHaveURL(/#page-work-roadmap$/);
  const roadmapPage = page.locator('[data-page-id="work-roadmap"]');
  await expect(roadmapPage.locator('.work-roadmap')).toBeVisible();
  await expect(roadmapPage.locator('.work-board, .work-tasks')).toHaveCount(0);
  const roadmapGeometry = await roadmapPage.evaluate((element) => {
    const scroll = element.querySelector('.work-roadmap-scroll');
    const calendar = element.querySelector('.work-roadmap-calendar-grid');
    const track = element.querySelector('.work-roadmap-track');
    const bar = element.querySelector('.work-roadmap-bar');
    if (!(scroll instanceof HTMLElement) || !(calendar instanceof HTMLElement) || !(track instanceof HTMLElement) || !(bar instanceof HTMLElement)) return null;
    const calendarBox = calendar.getBoundingClientRect();
    const trackBox = track.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return {
      calendarLeft: calendarBox.left,
      calendarWidth: calendarBox.width,
      trackLeft: trackBox.left,
      trackWidth: trackBox.width,
      barWidth: barBox.width,
      scrollsInternally: scroll.scrollWidth > scroll.clientWidth
    };
  });
  expect(roadmapGeometry).not.toBeNull();
  expect(Math.abs((roadmapGeometry?.calendarLeft ?? 0) - (roadmapGeometry?.trackLeft ?? 1))).toBeLessThan(1);
  expect(Math.abs((roadmapGeometry?.calendarWidth ?? 0) - (roadmapGeometry?.trackWidth ?? 1))).toBeLessThan(1);
  expect(roadmapGeometry?.barWidth).toBeGreaterThan(0);
  expect(roadmapGeometry?.scrollsInternally).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await cleanNavigation.filter({ hasText: 'Overview' }).click();
  const overviewPage = page.locator('[data-page-id="overview"]');
  await expect(overviewPage.getByText('Overview Attention', { exact: true })).toHaveCount(0);
  await expect(overviewPage.getByRole('heading', { name: '1 item needs your attention' })).toBeVisible();
  await expect(overviewPage.locator('.home-attention-metric')).toHaveCount(4);
  await expect(overviewPage.locator('.home-attention-icon .octicon')).toHaveCount(4);
  const metricGeometry = await overviewPage.locator('.home-attention-metric').evaluateAll((metrics) => metrics.map((metric) => {
    const metricBox = metric.getBoundingClientRect();
    const centers = ['.home-attention-icon', 'strong', '.home-attention-label'].map((selector) => {
      const box = metric.querySelector(selector)?.getBoundingClientRect();
      return box ? box.left + box.width / 2 : null;
    });
    const iconBox = metric.querySelector('.home-attention-icon .octicon')?.getBoundingClientRect();
    return {
      center: metricBox.left + metricBox.width / 2,
      centers,
      iconSize: iconBox ? [iconBox.width, iconBox.height] : null
    };
  }));
  for (const geometry of metricGeometry) {
    expect(geometry.iconSize).toEqual([32, 32]);
    for (const center of geometry.centers) {
      expect(Math.abs(Number(center) - geometry.center)).toBeLessThan(1);
    }
  }
  const firstMetric = overviewPage.locator('.home-attention-metric').first();
  const verticalOrder = await firstMetric.locator('strong, .home-attention-label, .home-attention-icon').evaluateAll((elements) => elements.map((element) => element.className || element.tagName.toLowerCase()));
  expect(verticalOrder).toEqual(['strong', 'home-attention-label', 'home-attention-icon']);
  const metricRowTops = await overviewPage.locator('.home-attention-metric').evaluateAll((metrics) => metrics.map((metric) => ({
    icon: metric.querySelector('.home-attention-icon')?.getBoundingClientRect().top,
    count: metric.querySelector('strong')?.getBoundingClientRect().top,
    label: metric.querySelector('.home-attention-label')?.getBoundingClientRect().top
  })));
  for (const tops of [
    metricRowTops.map((positions) => positions.icon),
    metricRowTops.map((positions) => positions.count),
    metricRowTops.map((positions) => positions.label)
  ]) {
    const numericTops = tops.filter((value) => typeof value === 'number');
    expect(Math.max(...numericTops) - Math.min(...numericTops)).toBeLessThan(1);
  }
  await expect(overviewPage.locator('[href="#page-overview-failed-runs"] strong')).toHaveText('—');
  await expect(overviewPage.locator('[href="#page-overview-blocked-work"]')).toHaveCount(0);
  await expect(overviewPage.locator('.home-attention-metric-empty').filter({ hasText: 'Blocked work' })).toHaveCount(1);
  await expect(overviewPage.locator('[href="#page-overview-awaiting-review"] strong')).toHaveText('1');
  await expect(overviewPage.locator('[href="#page-overview-security-findings"] strong')).toHaveText('—');
  const overviewElement = await overviewPage.elementHandle();
  expect(overviewElement).not.toBeNull();
  const attentionColors = await overviewElement?.evaluate((element) => {
    const root = element.closest('.dashboard-root');
    const activeReview = element.querySelector('.home-attention-metric-review.home-attention-metric-active strong');
    const emptyMetric = element.querySelector('.home-attention-metric-empty strong');
    if (!(root instanceof HTMLElement) || !(activeReview instanceof HTMLElement) || !(emptyMetric instanceof HTMLElement)) return null;
    /** @param {string} token */
    const resolvedColor = (token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      root.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      activeReview: getComputedStyle(activeReview).color,
      emptyMetric: getComputedStyle(emptyMetric).color,
      purple: resolvedColor('--purple'),
      muted: resolvedColor('--muted')
    };
  });
  expect(attentionColors).not.toBeNull();
  expect(attentionColors?.activeReview).toBe(attentionColors?.purple);
  expect(attentionColors?.emptyMetric).toBe(attentionColors?.muted);
  await expect(overviewPage.locator('.home-attention-detail')).toHaveCount(0);
  await expect(overviewPage.locator('.notifications-inbox')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const shellSize = await page.locator('.top-nav > .shell').evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });

  await overviewPage.locator('[href="#page-overview-failed-runs"]').click();
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

  await overviewPage.locator('[href="#page-overview-awaiting-review"]').click();
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

  for (const { label, pageId } of [
    { label: 'Work', pageId: 'work' },
    { label: 'Operations', pageId: 'agents' },
    { label: 'Insights', pageId: 'insights' }
  ]) {
    await experimental.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
    expect(await page.locator('.overview-header').evaluate((element) => element.getBoundingClientRect().height)).toBe(headerHeight);
    expect(await page.locator('.top-nav > .shell').evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    })).toEqual(shellSize);
    expect(await description.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    if (['work', 'agents'].includes(pageId)) {
      await expect(page.locator(`[data-page-id="${pageId}"] .table-summary-row`)).toHaveCount(0);
    }
  }

  // A 320px window can leave 305px of layout width when the browser reserves a scrollbar gutter.
  await page.setViewportSize({ width: 305, height: 844 });
  await page.evaluate(() => { window.location.hash = '#page-overview'; });
  await expect(overviewPage).toBeVisible();
  await expect(overviewPage.locator('.home-attention-metric')).toHaveCount(4);
  await page.locator('.mobile-nav-menu > summary').click();
  await expect(page.locator('.mobile-nav-section-label')).toHaveText(['Data', 'Experimental']);
  await expect(page.locator('[data-mobile-nav-page-id="operations"]')).toBeVisible();
  await page.locator('.mobile-nav-menu > summary').click();
  await expect(overviewPage.locator('.home-attention-metric').first()).toBeInViewport();
  await expect(overviewPage.locator('.custom-view')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(overviewPage.locator('.table-scroll')).toHaveCount(0);

  for (const pageName of ['overview', 'work', 'agents', 'insights']) {
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

test('Work uses focused mobile Board, Table, Roadmap, and detail interactions', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'mobile-work-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-07T12:00:00Z',
        'retrieved-at': '2026-09-07T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        'work-items': {
          source: 'work-items',
          metadata,
          rows: [
            { 'work-item-id': 'todo', name: 'Prepare rollout', owner: 'operations', package: 'release', scope: 'github/cao', 'lifecycle-state': 'waiting', 'started-at': '2026-08-30T09:00:00Z' },
            { 'work-item-id': 'active', name: 'Run validation', owner: 'automation', package: 'checks', scope: 'github/cao', 'lifecycle-state': 'active', 'started-at': '2026-09-02T09:00:00Z' },
            { 'work-item-id': 'review', name: 'Review evidence', owner: 'security', package: 'review', scope: 'github/cao', 'lifecycle-state': 'blocked', reason: 'Approval required', 'waiting-on': 'reviewer decision', 'started-at': '2026-09-03T09:00:00Z' },
            { 'work-item-id': 'done', name: 'Publish result', owner: 'operations', package: 'release', scope: 'github/cao', 'lifecycle-state': 'completed', 'started-at': '2026-09-04T09:00:00Z', 'ended-at': '2026-09-04T10:00:00Z' }
          ]
        }
      };
      window.location.hash = '#page-work';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const boardPage = page.locator('[data-page-id="work"]');
  await expect(boardPage).toBeVisible();
  await expect(boardPage.locator('.work-board-group-tabs')).toBeVisible();
  await expect(boardPage.locator('.work-board-column[data-mobile-active="true"]')).toHaveCount(1);
  await expect(boardPage.locator('.work-board-column[data-mobile-active="false"]').first()).toBeHidden();
  await boardPage.getByRole('tab', { name: /Todo/ }).click();
  await expect(boardPage.locator('.work-board-column[data-mobile-active="true"]')).toContainText('Prepare rollout');
  await expect(boardPage.locator('.work-board-column[data-mobile-active="true"] .work-board-cards')).toHaveCSS('overflow-y', 'visible');

  await boardPage.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(boardPage.locator('.work-filter-facets')).toBeVisible();
  await boardPage.getByRole('button', { name: 'Close work filters' }).click();
  await boardPage.getByRole('button', { name: 'Open Prepare rollout details' }).click();
  const detail = boardPage.getByRole('dialog', { name: 'Prepare rollout details' });
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox();
  expect(detailBox?.width).toBeCloseTo(390, 0);
  expect(detailBox?.height).toBeCloseTo(844, 0);
  await boardPage.getByRole('button', { name: 'Close Prepare rollout details' }).click();

  await boardPage.getByRole('link', { name: 'Tasks' }).click();
  const tablePage = page.locator('[data-page-id="work-tasks"]');
  await expect(tablePage.locator('.work-task-table-header')).toBeHidden();
  await expect(tablePage.locator('.work-task-row').first()).toBeVisible();
  expect(await tablePage.locator('.work-task-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await tablePage.getByRole('button', { name: 'Fields & sort' }).click();
  await expect(tablePage.locator('.work-task-settings-sheet')).toBeVisible();
  await tablePage.getByRole('button', { name: 'Close Table settings' }).click();

  await tablePage.getByRole('link', { name: 'Roadmap' }).click();
  const roadmapPage = page.locator('[data-page-id="work-roadmap"]');
  await expect(roadmapPage.locator('.work-roadmap-period-heading').first()).toBeVisible();
  await expect(roadmapPage.locator('.work-roadmap-calendar')).toBeHidden();
  expect(await roadmapPage.locator('.work-roadmap-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await roadmapPage.getByRole('button', { name: 'Show visual timeline' }).click();
  await expect(roadmapPage.locator('.work-roadmap-calendar')).toBeVisible();
  await expect(roadmapPage.getByRole('button', { name: 'Next month' })).toBeVisible();
  expect(await roadmapPage.locator('.work-roadmap-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('performance page renders one full-view lazy job table', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'performance-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-03T12:00:00Z',
        'retrieved-at': '2026-09-03T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const sources = {
        'run-performance': {
          source: 'run-performance',
          rows: [
            { run: '1', 'started-at': '2026-09-03T10:00:00Z', 'run-duration-seconds': 60 },
            { run: '2', 'started-at': '2026-09-03T11:00:00Z', 'run-duration-seconds': 180 }
          ],
          metadata
        },
        'job-performance': {
          source: 'job-performance',
          rows: [
            { run: '1', 'started-at': '2026-09-03T10:00:00Z', job: 'agent', runner: 'ubuntu-latest', 'sandbox-runtime': 'gvisor', engine: 'copilot', model: 'gpt-5.4', 'job-duration-seconds': 45 }
          ],
          metadata
        }
      };
      window.location.hash = '#page-performance';
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const pageRegion = page.locator('[data-page-id="performance"]');
  await expect(pageRegion).toBeVisible();
  await expect(pageRegion.locator('[data-view-layout="full-view"]')).toHaveCount(1);
  await expect(pageRegion.locator('[data-lazy-list]')).toBeVisible();
  await expect(pageRegion.locator('[data-chart-widget]')).toHaveCount(0);
  await expect(pageRegion.locator('tbody tr')).toHaveCount(1);
  await expect(pageRegion).toContainText('gvisor');
  await expect(pageRegion).toContainText('45s');
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
  await expect(details).toBeVisible();
  await expect(page.locator('.report-footer .refresh-button')).toHaveCount(0);
  const actionCenters = await page.locator('.report-actions > *').evaluateAll((items) => items.map((item) => {
    const bounds = item.getBoundingClientRect();
    return Math.round(bounds.top + bounds.height / 2);
  }));
  expect(new Set(actionCenters).size).toBe(1);
  const detailsBox = await details.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox?.x).toBeGreaterThanOrEqual(0);
  expect((detailsBox?.x ?? 0) + (detailsBox?.width ?? 0)).toBeLessThanOrEqual(393);
});

test('DLS-PAGE-002 DLS-PAGE-014 built-in overview page renders the report-style six-domain operational overview in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'built-in-overview-render',
          title: 'Built In Overview Render',
          pages: [
            {
              id: 'overview',
              kind: 'built-in',
              page: 'overview',
              title: 'Overview',
              definition: {
                'data-state': {
                  availability: true,
                  completeness: true,
                  freshness: true
                },
                views: [
                  { id: 'workflows-source', data: { source: 'workflows' } },
                  { id: 'runs-source', data: { source: 'runs' } },
                  { id: 'usage-source', data: { source: 'usage' } },
                  { id: 'findings-source', data: { source: 'findings' } },
                  { id: 'operational-values-source', data: { source: 'operational-values' } }
                ]
              }
            },
            {
              id: 'runtime',
              kind: 'custom',
              title: 'Runtime & episodes',
              views: [
                {
                  id: 'runtime-execution-episodes',
                  title: 'Observed root episodes',
                  data: { source: 'runtime-episodes' },
                  mark: 'table',
                  encoding: {
                    columns: [
                      { field: 'run', title: 'Run' },
                      { field: 'status', title: 'Result', display: 'status' }
                    ]
                  }
                }
              ]
            }
          ],
          navigation: [
            { label: 'Attention', pages: ['overview'] }
          ]
        }
      };

      const sources = {
        repositories: {
          source: 'repositories',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao' },
            { organization: 'github', repository: 'dashboard-service' }
          ],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', 'workflow-role': 'orchestrator', workflow: '.github/workflows/daily.yml', 'workflow-active': 'true', 'rollout-mode': 'review', 'package-rollout-percent': 100, 'package-targets': [{ repository: 'github/gh-aw', mode: 'live' }, { repository: 'github/gh-aw-firewall', mode: 'review' }, { repository: 'github/gh-aw-mcpg', mode: 'review' }, { repository: 'github/gh-aw-actions', mode: 'review' }, { repository: 'github/gh-aw-threat-detection', mode: 'review' }, { repository: 'githubnext/gh-aw-workshop', mode: 'review' }], 'max-ai-credits': 10, 'observed-at': '2026-08-29T09:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', 'workflow-role': 'worker', workflow: '.github/workflows/review.yml', 'workflow-active': 'false', 'rollout-mode': 'review', 'max-ai-credits': 20, 'observed-at': '2026-08-29T09:05:00Z' }
          ],
          metadata: {
            'source-id': 'workflows-fixture',
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
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', event: 'workflow_dispatch', 'started-at': '2026-08-29T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success', 'rollout-mode': 'live', engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', event: 'workflow_dispatch', 'started-at': '2026-08-29T11:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure', 'rollout-mode': 'live', engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1003', 'started-at': '2026-08-29T12:00:00Z', 'run-status': 'in-progress', 'run-conclusion': 'unknown', 'rollout-mode': 'review', engine: 'anthropic', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7' }
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
            { package: 'daily-ops', 'runtime-repository': 'github/gh-aw-cao', run: '1001', 'safe-output': 'daily-output-1', 'outcome-state': 'accepted', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:10:00Z' }
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
        },
        usage: {
          source: 'usage',
          rows: [
            { repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', 'rollout-mode': 'live', aic: 12, engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'observed-at': '2026-08-29T10:05:00Z' },
            { repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', 'rollout-mode': 'live', aic: 18, engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'observed-at': '2026-08-29T11:05:00Z' },
            { repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1003', 'rollout-mode': 'review', aic: 5, engine: 'anthropic', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7', 'observed-at': '2026-08-29T12:05:00Z' }
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
              finding: 'finding-2',
              'finding-summary': 'Review workflow needs triage',
              'finding-kind': 'authored-warning',
              'finding-severity': 'medium',
              'finding-status': 'unknown',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.yml',
              'observed-at': '2026-08-29T12:30:00Z',
              'issue-link': { relation: 'issue', href: 'https://example.com/issues/2', label: 'Issue 2' },
              'pull-request-link': { relation: 'pull-request', href: 'https://example.com/pulls/2', label: 'PR 2' },
              'run-link': { relation: 'run', href: 'https://example.com/runs/1003', label: 'Run 1003' }
            },
            {
              finding: 'finding-1',
              'finding-summary': 'Daily workflow regression',
              'finding-kind': 'authored-warning',
              'finding-severity': 'high',
              'finding-status': 'unknown',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              'observed-at': '2026-08-29T11:30:00Z',
              'issue-link': { relation: 'issue', href: 'https://example.com/issues/1', label: 'Issue 1' },
              'pull-request-link': { relation: 'pull-request', href: 'https://example.com/pulls/1', label: 'PR 1' },
              'run-link': { relation: 'run', href: 'https://example.com/runs/1002', label: 'Run 1002' }
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
        },
        'operational-values': {
          source: 'operational-values',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'operational-value': 0.65,
              'operational-value-definition': 'ship-success',
              'observed-at': '2026-08-29T10:30:00Z',
              'evidence-link': { relation: 'evidence', href: 'https://example.com/evidence/1', label: 'Evidence 1' }
            },
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.yml',
              run: '1003',
              'operational-value': 0.8,
              'operational-value-definition': 'review-quality',
              'observed-at': '2026-08-29T12:45:00Z',
              'evidence-link': { relation: 'evidence', href: 'https://example.com/evidence/2', label: 'Evidence 2' }
            }
          ],
          metadata: {
            'source-id': 'operational-values-fixture',
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

  await expect(page.getByRole('heading', { name: 'Overview', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('[data-breadcrumb-dashboard]')).toHaveText('Overview');
  await expect(page.locator('[data-breadcrumb-dashboard]')).toBeHidden();
  await expect(page.locator('[data-breadcrumb-page]')).toHaveText('Overview');
  await expect(page.locator('[data-page-mode]')).toBeHidden();
  await expect(page.locator('.nav-section-label')).toHaveCount(1);
  await expect(page.locator('.nav-section-label')).toHaveText(['Attention']);
  await expect(page.locator('.overview-page')).toHaveAttribute('data-page-kind', 'custom');
  await expect(page.locator('.overview-page .custom-view')).toHaveCount(2);
  await expect(page.locator('.overview-page .custom-view').first().locator('[data-chart-widget="swimlane"]')).toBeVisible();
  await expect(page.locator('.overview-page .layout-section')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Attention by domain', level: 2 })).toBeVisible();
  const cards = page.locator('.attention-domain-card');
  await expect(cards).toHaveCount(6);
  await expect(cards.locator('header strong')).toHaveText([
    'Runtime health',
    'Episodes & autonomy',
    'Security & controls',
    'Evidence quality',
    'Value & outcomes',
    'Cost & efficiency'
  ]);
  await expect(cards.first()).toHaveClass(/attention-domain-critical/);
  await expect(cards.first()).toContainText('1 failed');
  await expect(cards.nth(1)).toContainText('2 observed');
  await expect(cards.nth(2)).toContainText('2 signals');
  await expect(cards.nth(2)).toHaveClass(/attention-domain-investigate/);
  expect(await cards.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual([
    '#page-runtime',
    '#page-runtime?section=runtime-observed-root-episodes-heading',
    '#page-security',
    '#page-coverage',
    '#page-operational-value',
    '#page-cost'
  ]);
  await expect(page.locator('.overview-method-note')).toContainText('State key:');
  await expect(page.locator('.overview-page .overview-package-status')).toHaveCount(0);
  await expect(page.locator('[data-page-id="overview"] .data-state-summary')).toBeHidden();

  await page.setViewportSize({ width: 400, height: 900 });
  const firstCardBox = await cards.first().boundingBox();
  const secondCardBox = await cards.nth(1).boundingBox();
  expect(firstCardBox).not.toBeNull();
  expect(secondCardBox).not.toBeNull();
  expect(secondCardBox?.y).toBeGreaterThan(firstCardBox?.y ?? 0);

  await cards.nth(1).click();
  await expect(page).toHaveURL(/#page-runtime\?section=runtime-observed-root-episodes-heading$/);
  await expect(page.locator('[data-page-id="runtime"]')).toBeVisible();
  await expect(page.locator('#runtime-observed-root-episodes-heading')).toBeInViewport();

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
      const packages = ['EU CRA', 'Repository Ops', 'AW Optimization'];
      const roles = ['orchestrator', 'worker'];
      const modes = ['review', 'live', 'staged'];
      const sources = {
        inventory: {
          source: 'inventory',
          rows: Array.from({ length: 100 }, (_, index) => ({
            organization: 'githubnext',
            repository: \`repository-\${index + 1}\`,
            package: packages[index % packages.length],
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
                  { field: 'package', type: 'nominal' },
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
  const more = view.locator('[data-table-more]');
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
    expect((await lazyList.boundingBox())?.height).toBeGreaterThanOrEqual(850);
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
    await expect(siteCallout).toBeVisible();
    await expect(warningCallout).toBeVisible();
    await expect(summary).toBeVisible();
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

  await page.setViewportSize({ width: 390, height: 844 });
  expect((await view.boundingBox())?.height).toBeGreaterThanOrEqual(650);
  await expectTableFilterIsContained(view.locator('.table-scroll > .table-filter'));
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);

  await page.setViewportSize({ width: 1000, height: 900 });

  await view.locator('.table-scroll').evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(dashboardRoot).toHaveClass(/dashboard-full-view-scrolled/);
  await expect(page.locator('.top-nav')).toBeHidden();
  await expect(page.locator('.org-sidebar')).toBeHidden();
  expect((await lazyList.boundingBox())?.height).toBeGreaterThanOrEqual(890);
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
                y: { field: 'aic', type: 'quantitative', aggregate: 'sum', title: 'Total AIC' }
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
            { repository: 'a-very-long-repository-name-that-must-wrap-within-the-legend', aic: 5 },
            { repository: 'service', aic: 3 }
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

  const firstMark = chart.locator('.pie-chart-mark').first();
  expect(await firstMark.evaluate((mark) => {
    mark.focus();
    return mark === mark.parentElement?.lastElementChild;
  })).toBe(true);
});

test('DLS-PAGE-014 DLS-PAGE-015 built-in packages page renders report-style mode filters, AIC utilization, and run trends in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const metadata = {
        'source-id': 'packages-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T20:00:00Z',
        'retrieved-at': '2026-08-29T20:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const documentModel = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'packages-render',
          title: 'Central Agentic Ops',
          pages: [
            {
              id: 'packages',
              kind: 'built-in',
              page: 'packages',
              title: 'Packages',
              description: 'Activity from centrally managed packages.',
              definition: {
                'data-state': { availability: true, completeness: true, freshness: true },
                views: [
                  { id: 'package-workflows', data: { source: 'workflows' } },
                  { id: 'package-runs', data: { source: 'runs' } },
                  { id: 'package-usage', data: { source: 'usage' } },
                  {
                    id: 'packages-utilization',
                    title: 'Package AIC utilization',
                    data: { sources: ['workflows', 'usage'] },
                    mark: 'element',
                    element: 'package-utilization'
                  },
                  {
                    id: 'packages-run-trend',
                    title: 'All runs over time',
                    data: { sources: ['workflows', 'runs', 'outcomes'] },
                    mark: 'element',
                    element: 'package-run-trend'
                  },
                  {
                    id: 'packages-summary',
                    title: 'All output by package',
                    data: { sources: ['workflows', 'usage', 'findings', 'outcomes', 'runs'] },
                    mark: 'element',
                    element: 'package-summary-table'
                  }
                ]
              }
            },
            {
              id: 'operational-value',
              kind: 'custom',
              title: 'Value & outcomes',
              views: []
            },
            {
              id: 'package-insights',
              kind: 'custom',
              title: 'Package',
              route: { 'hash-query-parameter': 'package' },
              views: [
                {
                  id: 'package-operational-value',
                  title: 'Package operational value',
                  data: { sources: ['workflows', 'operational-values'] },
                  mark: 'element',
                  element: 'package-route',
                  config: { body: 'insights' }
                }
              ]
            },
            {
              id: 'package-detail',
              kind: 'custom',
              title: 'Package',
              route: { 'hash-query-parameter': 'package' },
              views: [
                {
                  id: 'package-workflow-navigation',
                  title: 'Package workflows',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'package-route',
                  config: { body: 'workflows' }
                },
                {
                  id: 'package-workflow-table',
                  title: 'Orchestrator and workers',
                  data: { source: 'packaged-workflows', 'route-field': 'package' },
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
              id: 'package-dispatches',
              kind: 'custom',
              title: 'Package',
              route: { 'hash-query-parameter': 'package' },
              views: [
                {
                  id: 'package-dispatch-navigation',
                  title: 'Package dispatches',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'package-route',
                  config: { body: 'dispatches' }
                },
                {
                  id: 'package-failure-reason-distribution',
                  title: 'Why these dispatches failed',
                  data: {
                    source: 'dispatches',
                    'route-field': 'package',
                    filters: { status: ['failure', 'startup-failure', 'timed-out', 'stale'] },
                    'order-by': [{ field: 'count-status-detail', direction: 'desc' }]
                  },
                  mark: 'chart',
                  chart: 'pie',
                  encoding: {
                    x: { field: 'status-detail', type: 'nominal', title: 'Failure reason' },
                    y: { field: 'status-detail', type: 'quantitative', aggregate: 'count', title: 'Failed dispatches' }
                  }
                },
                {
                  id: 'package-failed-dispatch-table',
                  title: 'Failed dispatches',
                  data: { source: 'dispatches', 'route-field': 'package', filters: { status: ['failure', 'startup-failure', 'timed-out', 'stale'] } },
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
                      context: ['package', 'status', 'status-detail', 'started-at', 'workflow-name', 'run-title', 'runtime-repository', 'run-link']
                    }]
                  }
                },
                {
                  id: 'package-dispatch-table',
                  title: 'All dispatches',
                  data: { source: 'dispatches', 'route-field': 'package' },
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
            {
              id: 'package-reports',
              kind: 'custom',
              title: 'Package',
              route: { 'hash-query-parameter': 'package' },
              views: [
                {
                  id: 'package-report-navigation',
                  title: 'Package reports',
                  data: { sources: ['workflows'] },
                  mark: 'element',
                  element: 'package-route',
                  config: { body: 'reports' }
                },
                {
                  id: 'package-report-table',
                  title: 'Reports',
                  data: { source: 'package-reports', 'route-field': 'package' },
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
        workflows: {
          source: 'workflows',
          rows: [
            { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 250, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
            { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', 'workflow-role': 'worker', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 800, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
            { package: 'aw-doctor', 'package-name': 'AW Doctor', 'package-icon': 'gear', workflow: '.github/workflows/aw-doctor.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': true, 'max-ai-credits': 250, 'package-aic-allowance': 1250, 'package-inventory-warnings': 1 }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { workflow: '.github/workflows/ambient-context-worker.md', run: '3', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T18:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/3', label: 'Run 3' } },
            { workflow: '.github/workflows/ambient-context-worker.md', run: '5', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T17:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/5', label: 'Run 5' } },
            { workflow: '.github/workflows/ambient-context-worker.md', run: '6', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T16:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/6', label: 'Run 6' } },
            { workflow: '.github/workflows/ambient-context-worker.md', run: '7', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T15:00:00Z', 'run-conclusion': 'failure', 'admission-reason': 'github-api-capacity-insufficient', 'resource-reset-at': '2026-08-29T19:00:00Z', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/7', label: 'Run 7' } },
            { workflow: '.github/workflows/ambient-context-worker.md', run: '8', event: 'workflow_dispatch', 'run-title': 'Refresh ambient context', 'started-at': '2026-08-29T14:00:00Z', 'run-conclusion': 'failure', 'failure-job': 'pre_activation', 'failure-message': 'Target authority missing: add .github/workflows/cao.json to the target default branch for live mode', 'failure-step': 'Run CAO control precompute', 'rollout-mode': 'review', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/8', label: 'Run 8' } },
            { workflow: '.github/workflows/aw-doctor.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' },
            { workflow: '.github/workflows/aw-doctor.md', run: '2', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'live' }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [
            { workflow: '.github/workflows/aw-doctor.md', run: '1', invocation: 'a', aic: 23.9, 'rollout-mode': 'review' }
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
        outcomes: {
          source: 'outcomes',
          rows: [
            { package: 'ambient-context', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', run: '3', 'run-conclusion': 'success', 'safe-output': 'ambient-review', 'outcome-title': 'Review ambient context proposal', 'outcome-summary': 'A review proposal is ready.', 'outcome-category': 'issue', 'outcome-status': 'open', 'outcome-state': 'pending', 'rollout-mode': 'review', 'published-at': '2026-08-29T18:00:00Z', 'observed-at': '2026-08-29T18:05:00Z' },
            { package: 'ambient-context', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', run: '4', 'run-conclusion': 'success', 'safe-output': 'ambient-live', 'outcome-title': 'Reconcile ambient context', 'outcome-summary': 'Updated durable guidance.', 'outcome-category': 'pull-request', 'outcome-status': 'closed', 'outcome-state': 'lifecycle-close', 'rollout-mode': 'live', 'published-at': '2026-08-28T18:00:00Z', 'observed-at': '2026-08-28T18:05:00Z' },
            { package: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '1', 'run-conclusion': 'success', 'safe-output': 'maintenance-review', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' },
            { package: 'aw-doctor', workflow: '.github/workflows/aw-doctor.md', run: '2', 'run-conclusion': 'failure', 'safe-output': 'maintenance-live', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:00:00Z' }
          ],
          metadata
        },
        'operational-values': {
          source: 'operational-values',
          rows: [],
          metadata
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Packages', level: 1 })).toBeVisible();
  await expect(page.locator('[data-page-id="packages"] [data-view-layout="full-view"]')).toBeVisible();
  await expect(page.locator('[data-page-id="packages"] [data-lazy-list]')).toBeVisible();
  await expect(page.locator('[data-page-id="packages"] [data-table-filter]')).toBeVisible();
  await expect(page.locator('[data-page-id="packages"] .table-summary-row')).toBeVisible();
  const packageRows = page.locator('[data-page-id="packages"] .custom-table tbody tr');
  await expect(packageRows).toHaveCount(2);
  await expect(page.locator('[data-page-id="packages"] .custom-table thead tr').first().locator('th')).toHaveText([
    'Package',
    'Workflows',
    'Roles',
    'Modes',
    'Registration',
    'Runs',
    'AIC'
  ]);
  const awDoctorSummary = packageRows.filter({ hasText: 'AW Doctor' });
  await expect(awDoctorSummary).toContainText('AW Doctor');
  await expect(awDoctorSummary).toContainText('23.9');
  await expect(awDoctorSummary.getByRole('link', { name: 'View AW Doctor package dashboard' })).toHaveAttribute('href', '#page-package-insights?package=aw-doctor');
  await expect(awDoctorSummary.locator('[data-field="modes"] .mode-badge')).toHaveText('review');
  await expect(awDoctorSummary.locator('[data-field="registration"] .status')).toHaveText('true');
  await page.evaluate(() => {
    window.location.hash = '#page-package-detail?package=ambient-context';
  });
  await expect(page.locator('[data-breadcrumb-page]')).toHaveText('Ambient Context');
  await expect(page.locator('[data-page-mode]')).toHaveText('Review');
  await expect(page.locator('[data-nav-page-id="packages"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Ambient Context views' })).toContainText('InsightsWorkflowsDispatchesReports');
  await expect(page.getByRole('heading', { name: 'Orchestrator and workers', level: 3 })).toBeVisible();
  const packageWorkflowRows = page.locator('[data-page-id="package-detail"] .custom-table tbody tr');
  await expect(packageWorkflowRows).toHaveCount(2);
  await expect(page.locator('[data-page-id="package-detail"] .custom-table thead tr').first().locator('th')).toHaveText([
    'Role',
    'Workflow',
    'Definition',
    'Mode',
    'Registration',
    'Runs',
    'Total AIC'
  ]);
  await expect(packageWorkflowRows.first()).toContainText('OrchestratorAmbient Context');
  await expect(packageWorkflowRows.first().locator('td').nth(5)).toHaveText('0');
  await expect(packageWorkflowRows.first().locator('td').nth(6)).toHaveText('—');
  await expect(packageWorkflowRows.nth(1)).toContainText('WorkerAmbient Context Worker');

  await page.getByRole('navigation', { name: 'Ambient Context views' }).getByRole('link', { name: 'Dispatches' }).click();
  await expect(page).toHaveURL(/#page-package-dispatches\?package=ambient-context$/);
  const failureReasonChart = page.getByRole('heading', { name: 'Why these dispatches failed', level: 3 }).locator('..');
  await expect(failureReasonChart.locator('.pie-chart-widget')).toHaveAttribute('data-chart-widget', 'pie');
  await expect(failureReasonChart.locator('.pie-chart-total-value')).toHaveText('5');
  await expect(failureReasonChart.locator('.chart-legend-pie li')).toHaveCount(2);
  await expect(failureReasonChart.locator('.chart-legend-pie')).toContainText('GitHub API capacity insufficient4');
  await expect(failureReasonChart.locator('.chart-legend-pie')).toContainText('Target authority missing: add .github/workflows/cao.json to the target default branch for live mode1');
  const failedDispatchSection = page.getByRole('heading', { name: 'Failed dispatches', level: 3 }).locator('..');
  const failedDispatchRows = failedDispatchSection.locator('tbody tr');
  await expect(failedDispatchRows).toHaveCount(5);
  await expect(failedDispatchSection.locator('thead tr').first().locator('th')).toHaveText([
    'Action',
    'Why',
    'Started',
    'Workflow',
    'Run title',
    'Runtime repository'
  ]);
  await expect(failedDispatchRows.first().locator('[data-field="status-detail"]')).toHaveText('GitHub API capacity insufficient; reset 1 hour ago');
  await expect(failedDispatchRows.last().locator('[data-field="status-detail"]')).toHaveText('Target authority missing: add .github/workflows/cao.json to the target default branch for live mode');
  await expect(failedDispatchRows.first().locator('[data-field="status-detail"]')).toHaveAttribute('data-status', 'failure');
  await expect(failedDispatchRows.locator('[data-field="status-detail"] a')).toHaveCount(5);
  await expect(failedDispatchRows.locator('.table-intent-button')).toHaveCount(5);
  const intentButton = failedDispatchRows.first().getByRole('button', { name: 'Review debug prompt' });
  await expect(intentButton).toContainText('Review debug prompt');
  await intentButton.click();
  const intentDialog = page.getByRole('dialog', { name: 'Review debug prompt prompt preview' });
  await expect(intentDialog).toBeVisible();
  await expect(intentDialog.locator('.table-intent-preview')).toContainText('Debug this failed workflow dispatch.');
  await expect(intentDialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await intentDialog.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(intentDialog).toBeHidden();
  await expect(intentButton).toBeFocused();
  await expect(failedDispatchRows.first().locator('[data-field="status-detail"] a')).toHaveAttribute('href', 'https://github.com/githubnext/gh-aw-cao/actions/runs/3');
  const allDispatchRows = page.getByRole('heading', { name: 'All dispatches', level: 3 }).locator('..').locator('tbody tr');
  await expect(allDispatchRows).toHaveCount(5);

  await page.getByRole('navigation', { name: 'Ambient Context views' }).getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/#page-package-reports\?package=ambient-context$/);
  await expect(page.getByRole('heading', { name: 'Reports', level: 3 })).toBeVisible();
  const packageReportRows = page.locator('[data-page-id="package-reports"] .custom-table tbody tr');
  await expect(packageReportRows).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Filter Reports' }).fill('Reconcile');
  const visiblePackageReportRows = page.locator('[data-page-id="package-reports"] .custom-table tbody tr:visible');
  await expect(visiblePackageReportRows).toHaveCount(1);
  await expect(visiblePackageReportRows).toContainText('Reconcile ambient context');
});

test('DLS-PAGE-017 renders an editable filter bar and applies changes automatically', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'filter-bar-render',
          title: 'Central Agentic Ops',
          callouts: [{
            id: 'partial-data',
            title: 'Dashboard data is partial',
            description: 'Data Health reports a collection gap.',
            'navigation-page': 'data-health'
          }],
          pages: [{
            id: 'cost',
            kind: 'custom',
            title: 'Cost & efficiency',
            views: [{
              id: 'usage-count',
              data: { source: 'usage' },
              mark: 'metric',
              encoding: { value: { field: 'invocation', aggregate: 'count' } }
            }]
          }]
        }
      };
      const sources = {
        usage: {
          source: 'usage',
          rows: [
            { invocation: 'usage-1', aic: 2, 'rollout-mode': 'review' },
            { invocation: 'usage-2', aic: 3, 'rollout-mode': 'live' }
          ],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-31T16:00:00Z',
            'retrieved-at': '2026-08-31T16:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const filterBar = page.getByLabel('Dashboard filters');
  await expect(filterBar).toBeVisible();
  await expect(filterBar.locator(':scope > .dashboard-horizon')).toHaveCount(1);
  await expect(page.locator('.report-actions > .dashboard-horizon')).toHaveCount(0);
  await expect(filterBar.locator('.filter-tuning-controls')).toBeHidden();
  await filterBar.locator('.horizon-toggle').click();
  const filterInput = filterBar.getByRole('searchbox', { name: 'Current filters' });
  await expect(filterInput).toHaveValue('');
  await expect(filterBar.getByRole('combobox', { name: 'Time window' })).toHaveValue('1w');
  await expect(filterBar.getByRole('checkbox')).toHaveCount(3);
  expect(await filterBar.getByRole('checkbox').evaluateAll(
    (inputs) => inputs.every((input) => /** @type {HTMLInputElement} */ (input).checked)
  )).toBe(true);
  const desktopPanelBox = await filterBar.locator('.filter-tuning-controls').boundingBox();
  const desktopTimeRangeBox = await filterBar.locator('.time-window-control').boundingBox();
  expect(desktopTimeRangeBox?.x).toBeGreaterThanOrEqual(desktopPanelBox?.x ?? 0);
  expect((desktopTimeRangeBox?.x ?? 0) + (desktopTimeRangeBox?.width ?? 0))
    .toBeLessThanOrEqual((desktopPanelBox?.x ?? 0) + (desktopPanelBox?.width ?? 0));
  await expect(filterBar.getByRole('link', { name: 'Export JSON' })).toHaveCount(0);
  await expect(page.locator('[data-page-id="cost"] [data-metric-value="invocation"]')).toHaveText('2');

  await filterBar.getByRole('checkbox', { name: 'review' }).uncheck();
  await expect(filterBar.locator('.count-badge')).toHaveText('2');
  await expect(page.locator('[data-page-id="cost"] [data-metric-value="invocation"]')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('central-agentic-ops.dashboard.horizon-filter-settings') ?? '{}'
  ).modes)).toEqual(['live', 'unknown']);
  await filterBar.locator('.horizon-toggle').click();

  await page.setViewportSize({ width: 400, height: 900 });
  expect((await page.getByRole('link', { name: 'View data health' }).boundingBox())?.height)
    .toBeGreaterThanOrEqual(24);
  const horizonBox = await filterBar.locator('.dashboard-horizon').boundingBox();
  expect(horizonBox).not.toBeNull();
  await expect(filterBar.locator('.filter-tuning-controls')).toBeHidden();
  await filterBar.locator('.horizon-toggle').click();
  const expandedHorizonBox = await filterBar.locator('.dashboard-horizon').boundingBox();
  const tuningControls = filterBar.locator('.filter-tuning-controls');
  const timeRangeBox = await tuningControls.locator('.time-window-control').boundingBox();
  const tuningControlsBox = await tuningControls.boundingBox();
  expect(timeRangeBox?.y).toBeGreaterThanOrEqual((expandedHorizonBox?.y ?? 0) + (expandedHorizonBox?.height ?? 0));
  expect(tuningControlsBox?.x).toBeGreaterThanOrEqual(0);
  expect((tuningControlsBox?.x ?? 0) + (tuningControlsBox?.width ?? 0)).toBeLessThanOrEqual(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
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
            {
              id: 'evals',
              kind: 'built-in',
              page: 'evals',
              title: 'Evals',
              definition: {
                'data-state': {
                  availability: true,
                  completeness: true,
                  freshness: true
                },
                views: [
                  { id: 'evals-source', data: { source: 'evals' } },
                  { id: 'eval-observations-source', data: { source: 'eval-observations' } }
                ]
              }
            }
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
            {
              id: 'findings',
              kind: 'built-in',
              page: 'findings',
              title: 'Findings',
              definition: {
                'data-state': {
                  availability: true,
                  completeness: true,
                  freshness: true
                },
                views: [
                  { id: 'findings-source', data: { source: 'findings' } }
                ]
              }
            }
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
  const refreshMask = await page.locator('.refresh-button').evaluate((button) => getComputedStyle(button, '::after').maskImage);
  const repositoryLinkMask = await page.locator('.repository-link').evaluate((link) => getComputedStyle(link, '::after').maskImage);
  expect(externalLinkMask).not.toBe('none');
  expect(refreshMask).toBe('none');
  expect(repositoryLinkMask).toBe('none');
});

test('DLS-VIEW-013 DLS-VIEW-014 DLS-VIEW-015 DLS-SAFE-006 custom views render available, empty, and unavailable states with only context-permitted observations in browser', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

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
              finding: 'finding-1',
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
              finding: 'finding-2',
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
              finding: 'finding-3',
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

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Custom Views', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Total AI Credits' })).toBeVisible();
  await expect(page.locator('[data-metric-value="aic"]')).toHaveText('5');
  const metricSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Total AI Credits' }) });
  await expect(metricSection).not.toContainText('Source: usage');
  await expect(metricSection).not.toContainText('Filters:');

  await expect(page.getByRole('heading', { name: 'Findings Table' })).toBeVisible();
  await expect(page.locator('.custom-table tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'PR 1' })).toHaveAttribute('href', 'https://example.com/pull/1');
  const tableSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Findings Table' }) });
  await expect(tableSection).not.toContainText('Scope:');
  await expect(tableSection).not.toContainText('Time:');
  await expect(tableSection).not.toContainText('Out of scope finding');
  await expect(tableSection).not.toContainText('Out of range finding');

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

  await hydrateView(page, 'Missing Source');
  await expect(page.getByRole('heading', { name: 'Missing Source' })).toBeVisible();
  await expect(page.locator('[data-view-availability="unavailable"]')).toHaveText('This view cannot be shown because its data source is unavailable.');
  const unavailableSection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Missing Source' }) });
  await expect(unavailableSection).toContainText('Source unavailable: missing-source');
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
  await page.goto('about:blank#page-repository-detail?repository=octo-org%2Focto-repo');
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      const metadata = {
        'source-id': 'workflows-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-08-30T08:00:00Z',
        'retrieved-at': '2026-08-30T08:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repository-route',
          title: 'Repository route',
          pages: [{
            id: 'repository-detail',
            kind: 'custom',
            title: 'Repository',
            description: 'Repository workflows.',
            route: { 'hash-query-parameter': 'repository' },
            views: [{
              id: 'repository-workflows',
              title: 'Agentic workflows',
              data: { source: 'repository-workflows', 'route-field': 'repository' },
              mark: 'table',
              controls: 'static',
              encoding: {
                columns: [
                  { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                  { field: 'workflow-active', type: 'nominal', title: 'State', display: 'active-state' }
                ]
              }
            }]
          }]
        }
      };
      const sources = {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [
            { organization: 'octo-org', repository: 'octo-repo', workflow: 'review.md', 'workflow-name': 'Review', 'workflow-active': 'true' },
            { organization: 'other-org', repository: 'other-repo', workflow: 'other.md', 'workflow-name': 'Other', 'workflow-active': 'true' }
          ]
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('octo-org/octo-repo');
  await expect(page.locator('[data-route-view] .custom-table')).toContainText('Review');
  await expect(page.locator('[data-route-view] .custom-table')).not.toContainText('Other');

  await page.evaluate(() => {
    window.location.hash = '#page-repository-detail?repository=other-org%2Fother-repo';
  });

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('other-org/other-repo');
  await expect(page.locator('[data-route-view] .custom-table')).toContainText('Other');
  await expect(page.locator('[data-route-view] .custom-table')).not.toContainText('Review');
});

test('workflow page template follows its JSON-declared route and renders attributed reports', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  const workflowRoute = 'githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fambient-context.md';
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
            package: 'ambient-context',
            'package-name': 'Ambient Context',
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

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ambient Context');
  await expect(page.locator('[data-breadcrumb-root]')).toHaveText('Repositories');
  await expect(page.locator('[data-breadcrumb-dashboard]')).toHaveText('githubnext/gh-aw-cao');
  await expect(page.locator('.workflow-identity')).toContainText('.github/workflows/ambient-context.md');
  await expect(page.getByRole('navigation', { name: '.github/workflows/ambient-context.md views' })).toContainText('InsightsReportsRuns');
  await expect(page.locator('#page-workflow-detail .custom-table')).toContainText('Debug ambient context workflow failure');
  await expect(page.locator('#page-workflow-detail .custom-table .status-success')).toHaveText('closed');
  await expect(page.locator('#page-workflow-detail .custom-table .mode-review')).toHaveText('review');
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ambient Context');
  await expect(page.locator('.horizon-summary').getByRole('group', { name: 'Data status' })).toHaveCount(0);
  await page.locator('.horizon-toggle').click();
  await expect(page.locator('.filter-tuning-controls .horizon-details').getByRole('group', { name: 'Data status' })).toContainText('CompletenesscompleteFreshnessfresh');
  await expect(page.locator('#page-workflow-runs').getByRole('group', { name: 'Data status' })).toHaveCount(0);
  await expect(page.locator('#page-workflow-runs .custom-table tbody tr')).toHaveCount(2);
  await page.locator('#page-workflow-runs').getByRole('button', { name: /^Started/ }).click();
  await expect(page.locator('#page-workflow-runs').getByRole('columnheader', { name: /^Started/ })).toHaveAttribute('aria-sort', 'ascending');
  await page.locator('#page-workflow-runs').getByRole('searchbox', { name: 'Filter Runs' }).fill('Manual review');
  await expect(page.locator('#page-workflow-runs .custom-table tbody tr:visible')).toHaveCount(1);
  await expect(page.locator('#page-workflow-runs .custom-table tbody')).toContainText('Manual review');
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
            package: 'ambient-context',
            'package-name': 'Ambient Context',
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
  await page.locator('#page-workflow-detail .custom-table tbody a').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Debug ambient context workflow failure');
  await expect(page.locator('.outcome-meta a', { hasText: 'Ambient Context' })).toHaveAttribute(
    'href',
    '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fambient-context.md'
  );
});

test('workflow runtime route renders JSON-declared workflow insights', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.goto('about:blank#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md');
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
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
          pages: [{
            id: 'workflow-runtime',
            kind: 'custom',
            title: 'Workflow runtime',
            route: { 'hash-query-parameter': 'workflow' },
            views: [{
              id: 'workflow-runtime-route',
              title: 'Workflow runtime',
              data: { sources: ['workflows', 'runs', 'usage', 'operational-values'] },
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
            package: 'testing',
            'package-name': 'Testing',
            'package-memberships': [
              { id: 'testing', name: 'Testing' },
              { id: 'central-agentic-ops', name: 'Central Agentic Ops' }
            ],
            'workflow-active': 'true',
            'rollout-mode': 'review'
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
        'operational-values': {
          source: 'operational-values',
          metadata,
          rows: []
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Multi-Device Docs Tester', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Multi-Device Docs Tester views' })).toContainText('InsightsReportsRuns');
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', /#page-workflow-detail\?workflow=/);
  await expect(page.locator('.workflow-badges .workflow-badge')).toHaveText([
    'Standalone',
    'Package · Central Agentic Ops',
    'Package · Testing'
  ]);
  await expect(page.getByRole('link', { name: 'View authored workflow' })).toHaveAttribute(
    'href',
    'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md'
  );
  await expect(page.locator('.workflow-runtime-metrics')).toContainText('1');
  await expect(page.locator('.workflow-runtime-metrics')).toContainText('962.7 AIC');
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

  await page.getByRole('button', { name: 'Show all rows' }).click();
  await expect(visibleRows).toHaveCount(30);
  await expect(page.locator('.table-region')).toHaveClass(/table-region-expanded/);
  await expect(page.locator('.table-scroll')).toHaveCSS('max-height', 'none');
  await expect(page.locator('.table-scroll')).toHaveCSS('overflow', 'visible');

  await page.locator('[data-table-facet="rollout-mode"]').selectOption('review');
  await expect(visibleRows).toHaveCount(15);
  await expect(page.locator('.table-filter-result')).toHaveText('Showing 15 of 15 results');

  await page.getByRole('searchbox', { name: 'Filter Workflow catalog' }).fill('workflow-29');
  await expect(visibleRows).toHaveCount(1);
  await expect(visibleRows).toContainText('workflow-29');
  await expect(page.locator('.table-filter-result')).toHaveText('Showing 1 of 1 result');
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
  await page.setContent(`
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
  `);

  const toggle = page.getByRole('button', { name: 'Collapse navigation' });
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
  await toggle.click();

  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '64px');
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.nav-label').first()).toBeHidden();
  await expect(page.locator('.sidebar-brand')).toBeHidden();

  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.nav-label').first()).toBeVisible();
  await expect(page.locator('.sidebar-brand')).toBeVisible();

  await page.locator('.dashboard-root').evaluate((root) => root.classList.add('dashboard-copilot-enabled'));
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
});

test('phone navigation uses icon shortcuts and a full-label view menu without horizontal scrolling', async ({ page }) => {
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
            id: 'phone-navigation-dashboard',
            title: 'Phone Navigation',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] },
              { id: 'security', kind: 'custom', title: 'Security', icon: 'shield', views: [] },
              { id: 'value', kind: 'custom', title: 'Value', icon: 'graph', views: [] },
              { id: 'cost', kind: 'custom', title: 'Cost & efficiency', icon: 'meter', views: [] },
              { id: 'packages', kind: 'custom', title: 'Packages', icon: 'package', views: [] }
            ],
            navigation: [
              { label: 'Main', pages: ['overview', 'runs', 'security'] },
              { label: 'Investigate', pages: ['value', 'cost', 'packages'] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `);

  const shortcuts = page.locator('.nav-section-items > .nav-item');
  const activeItem = page.locator('.nav-section-items > .nav-item[aria-current="page"]');
  const historyBack = page.getByRole('button', { name: 'Go back' });
  await expect(historyBack).toBeHidden();
  await expect(activeItem).toBeVisible();
  await expect(activeItem.locator('.nav-label')).toBeHidden();
  expect(await activeItem.evaluate((item) => getComputedStyle(item, '::before').content)).toBe('none');
  await expect(shortcuts).toHaveCount(6);
  await expect(shortcuts.nth(4)).toBeVisible();
  await expect(shortcuts.nth(4).locator('.octicon-meter')).toBeVisible();
  await expect(shortcuts.nth(5)).toBeHidden();
  await expect(page.locator('.nav-section').first()).toHaveCSS('flex-direction', 'row');
  await expect(page.locator('.nav-section-items').first()).toHaveCSS('flex-direction', 'row');
  await expect(page.locator('.primary-nav')).not.toHaveCSS('overflow-x', 'auto');

  await page.getByRole('button', { name: 'Select view' }).click();
  const menu = page.locator('.mobile-nav-menu-list');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.octicon-package')).toBeVisible();
  await expect(menu.getByText('Cost & efficiency', { exact: true })).toBeVisible();
  await menu.getByText('Cost & efficiency', { exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Cost & efficiency', level: 1 })).toBeVisible();
  await expect(historyBack).toBeVisible();
  await historyBack.click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(historyBack).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
