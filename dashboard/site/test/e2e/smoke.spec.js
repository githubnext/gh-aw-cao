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
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  const firstView = page.locator('[data-page-id="overview"] .custom-view').first();
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

test('GitHub API rate-limit dashboard remains operable at desktop and narrow widths', async ({ page }) => {
  const documentModel = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const documentModel = ${JSON.stringify(documentModel)};
      const metadata = {
        'source-id': 'rate-limit-viewport-fixture',
        'source-kind': 'fixture',
        'as-of': '2026-09-04T12:00:00Z',
        'retrieved-at': '2026-09-04T12:01:00Z',
        completeness: 'complete',
        freshness: 'fresh',
        availability: 'available'
      };
      const row = {
        'observation-id': 'run-1:after:reader:core:2026-09-04T12:00:00Z',
        'operation-execution-id': 'run-1',
        'observed-at': '2026-09-04T12:00:00Z',
        phase: 'after',
        operation: 'refresh-activity',
        outcome: 'success',
        credential: 'reader',
        'credential-type': 'app',
        resource: 'core',
        bucket: 'core · reader',
        'maximum-lane': 'core · reader · max 5000',
        'history-series': 'core · reader',
        remaining: 1000,
        limit: 5000,
        used: 4000,
        'remaining-percent': 20,
        'reset-at': '2026-09-04T13:00:00Z',
        'minutes-to-reset': 60,
        'burn-rate-per-minute': 20,
        'projected-remaining-at-reset': -200,
        'projected-exhaustion-at': '2026-09-04T12:50:00Z',
        'runway-ratio': 0.83,
        'risk-status': 'critical',
        'risk-order': 0,
        'is-current': true,
        'attribution-status': 'available',
        'operation-consumed': 20
      };
      const sources = {
        'github-api-rate-limits': {
          source: 'github-api-rate-limits',
          metadata,
          rows: [
            { ...row, 'observation-id': 'run-0:after:reader:core:2026-09-04T11:00:00Z', 'operation-execution-id': 'run-0', 'observed-at': '2026-09-04T11:00:00Z', remaining: 2200, used: 2800, 'remaining-percent': 44, 'is-current': false },
            row
          ]
        },
        'github-api-collector-health': {
          source: 'github-api-collector-health',
          metadata,
          rows: [{
            'observed-at': '2026-09-04T12:00:00Z',
            'operation-execution-id': 'run-1',
            phase: 'after',
            operation: 'refresh-activity',
            outcome: 'success',
            credential: 'reader',
            'cache-hydrated': true,
            'cache-entries': 12,
            'cache-folders': 2,
            'rate-limit-error': ''
          }]
        }
      };
      document.querySelector('#root').append(renderDashboard({ document: documentModel, sources }));
    </script>
  `);

  await page.locator('.nav-section').filter({ hasText: 'Control plane' }).locator('summary').click();
  await page.locator('[data-nav-page-id="github-api"]').click();
  const apiPage = page.locator('[data-page-id="github-api"]');
  const capacity = apiPage.locator('[aria-labelledby="github-api-remaining-capacity-heading"]');
  const capacityChart = capacity.locator('[data-chart-widget="bar"]');
  await expect(capacityChart).toBeVisible();
  await expect(apiPage.getByText('critical', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => {
    const box = await capacityChart.boundingBox();
    return box !== null && box.width <= 1200;
  }).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(capacityChart).toBeVisible();
  await expect.poll(async () => {
    const box = await capacityChart.boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
  await expect(apiPage.locator('details[data-disclosure="supplemental"]')).toHaveCount(5);
});

test('control-plane readiness surfaces blocking regressions', async ({ page }) => {
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
  await expect(page.locator('.nav-section-label').filter({ hasText: 'Control plane' })).toBeVisible();
  const activityChart = readinessPage.locator('.custom-view').first().locator('[data-chart-widget="line"]');
  await expect(activityChart).toBeVisible();
  const [activityChartBox, activityAxisBox] = await Promise.all([
    activityChart.boundingBox(),
    activityChart.locator('.line-chart-axis').boundingBox()
  ]);
  expect(activityChartBox).not.toBeNull();
  expect(activityAxisBox).not.toBeNull();
  expect(activityAxisBox?.width).toBeGreaterThan((activityChartBox?.width ?? 0) * 0.95);
  await expect(activityChart.locator('.line-chart-series').first()).toHaveCSS('stroke-dasharray', 'none');
  expect(Number.parseFloat(await activityChart.locator('.line-chart-point').first().evaluate(
    (point) => getComputedStyle(point).strokeWidth
  ))).toBeGreaterThanOrEqual(2);
  await expect(readinessPage).toContainText('Not ready');
  await expect(readinessPage).toContainText('3 completed runs observed');
  await expect(readinessPage).toContainText('Worker failures');
  await expect(readinessPage).toContainText('Worker warnings');
  await expect(readinessPage).toContainText('No-op reports');
  await expect(readinessPage).toContainText('Runtime regression');
  await expect(readinessPage).toContainText('Output warning');
  await expect(readinessPage).toContainText('Smoke regression');

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
  await expect(readinessPage).toContainText('Ready to ship');
  await expect(readinessPage).toContainText('1 completed runs observed');
  await expect(readinessPage).not.toContainText('Smoke regression');
  await expect(readinessPage).not.toContainText('No failures observed');
  await expect(readinessPage).not.toContainText('No warnings observed');
  await expect(readinessPage).not.toContainText('No no-op reports observed');
  await horizonFilter.locator('.horizon-toggle').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(horizonFilter.locator('.time-window-control')).toBeHidden();
  await horizonFilter.locator('.horizon-toggle').click();
  await expect(horizonFilter.locator('.time-window-control')).toBeVisible();
  await expect(horizonFilter.locator('[aria-label="Window start time"]')).toBeVisible();
  await expect(horizonFilter.locator('[aria-label="Window stop time"]')).toBeVisible();
  expect(await readinessPage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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

test('Dashboard Next preserves the Home decision hierarchy across desktop and mobile', async ({ page }) => {
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
          rows: [{
            'work-item-id': 'dependabot:github/gh-aw:release-train',
            objective: 'Update the Dependabot release train',
            scope: 'github/gh-aw',
            'lifecycle-state': 'review',
            phase: 'verifying',
            reason: 'Security review remains pending.',
            'next-action': 'Review the dependency update evidence',
            'waiting-on': 'security-reviewers',
            owner: 'dependency-automation',
            'evidence-link': evidenceLink
          }],
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

  const dashboardNext = page.locator('.nav-section').filter({ hasText: 'Dashboard Next' });
  await dashboardNext.locator('summary').click();
  await expect(dashboardNext.getByRole('link')).toHaveText(['Home', 'Work', 'Agents', 'Evidence', 'Insights']);

  await dashboardNext.getByRole('link', { name: 'Home' }).click();
  const homePage = page.locator('[data-page-id="home"]');
  await expect(homePage.getByRole('heading', { level: 3 })).toHaveText([
    'Need attention',
    'Work in progress',
    'Outcomes',
    'Operational pulse'
  ]);
  await expect(homePage.getByRole('columnheader')).toHaveText([
    'Work', 'Scope', 'Phase', 'Why', 'Next action', 'Owner',
    'Outcome', 'Repository', 'Disposition', 'Observed'
  ]);
  await expect(homePage.locator('.canonical-attention-item')).toHaveCount(1);
  await expect(homePage.locator('.signal-priority-rank strong')).toHaveText('1');
  await expect(homePage.locator('.canonical-attention-item')).toContainText('Upgrade agentic workflow dependencies');
  await expect(homePage.locator('.canonical-attention-item')).not.toContainText('Update the Dependabot release train');
  await expect(homePage.locator('a[href="https://example.com/evidence/release-train"]')).not.toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  for (const pageName of ['Work', 'Agents', 'Evidence', 'Insights']) {
    await dashboardNext.getByRole('link', { name: pageName }).click();
    await expect(page.getByRole('heading', { name: pageName, exact: true, level: 1 })).toBeVisible();
    if (['Work', 'Agents', 'Evidence'].includes(pageName)) {
      await expect(page.locator(`[data-page-id="${pageName.toLowerCase()}"] .table-summary-row`)).toHaveCount(0);
    }
  }

  // A 320px window can leave 305px of layout width when the browser reserves a scrollbar gutter.
  await page.setViewportSize({ width: 305, height: 844 });
  await page.evaluate(() => { window.location.hash = '#page-home'; });
  await expect(homePage).toBeVisible();
  await expect(homePage.locator('.canonical-attention-item').first()).toBeInViewport();
  await expect(homePage.locator('.custom-view').nth(1).locator('tbody tr').first()).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(homePage.locator('.table-scroll').first()).toBeVisible();

  for (const pageName of ['home', 'work', 'agents', 'evidence', 'insights']) {
    await page.evaluate((nextPage) => { window.location.hash = `#page-${nextPage}`; }, pageName);
    const activePage = page.locator(`[data-page-id="${pageName}"]`);
    await expect(activePage).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const chart of await activePage.locator('[data-chart-widget]').all()) {
      const box = await chart.boundingBox();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
    }
  }
});

test('performance page renders a full heatmap and lays out supporting charts side by side', async ({ page }) => {
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
  await expect(pageRegion.locator('.custom-view').first().locator('[data-chart-widget="histogram"]')).toBeVisible();
  await expect(pageRegion.locator('[data-chart-widget="heatmap"]')).toBeVisible();
  await expect(pageRegion.locator('[data-chart-widget="bar"]')).toHaveCount(2);
  const runtimeCharts = pageRegion.locator('[data-section-id="job-duration"] .custom-view-grid > [data-view-layout="half"]');
  await expect(runtimeCharts).toHaveCount(2);
  const chartLayout = await runtimeCharts.evaluateAll((charts) => {
    const bounds = charts.map((chart) => chart.getBoundingClientRect());
    return {
      widgetHeights: charts.map((chart) => chart.querySelector('.chart-widget')?.getBoundingClientRect().height ?? 0),
      firstRow: {
        leftX: bounds[0].x,
        rightX: bounds[1].x,
        verticalOffset: Math.abs(bounds[0].y - bounds[1].y)
      }
    };
  });
  expect(chartLayout.firstRow.leftX).toBeLessThan(chartLayout.firstRow.rightX);
  expect(chartLayout.firstRow.verticalOffset).toBeLessThan(1);
  expect(Math.max(...chartLayout.widgetHeights) - Math.min(...chartLayout.widgetHeights)).toBeLessThan(1);
});

test('DLS-DOC-014 horizon help is available on hover and keyboard focus', async ({ page }) => {
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

  const trigger = page.getByRole('button', { name: 'Horizon details' });
  const tooltip = page.getByRole('tooltip');
  await expect(trigger).toHaveAttribute('aria-describedby', 'dashboard-horizon-details');
  await expect(tooltip).toBeHidden();
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('StartAug 25, 2026, 12:00 PM UTC');
  await expect(tooltip).toContainText('EndSep 1, 2026, 12:00 PM UTC');
  await expect(tooltip).toContainText('Duration1 week');
  await page.mouse.move(0, 0);
  await trigger.focus();
  await expect(tooltip).toBeVisible();

  await page.setViewportSize({ width: 393, height: 852 });
  await trigger.blur();
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  await expect(page.locator('.refresh-button > span')).toBeHidden();
  const actionCenters = await page.locator('.report-actions > *').evaluateAll((items) => items.map((item) => {
    const bounds = item.getBoundingClientRect();
    return Math.round(bounds.top + bounds.height / 2);
  }));
  expect(new Set(actionCenters).size).toBe(1);
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox?.x).toBeGreaterThanOrEqual(0);
  expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(393);
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

test('built-in repositories page keeps repository scope above the run metadata', async ({ page }) => {
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
      const sources = {
        repositories: {
          source: 'repositories',
          rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
          metadata
        },
        runs: emptySource('runs'),
        usage: emptySource('usage'),
        workflows: emptySource('workflows'),
        outcomes: emptySource('outcomes'),
        'operational-values': emptySource('operational-values')
      };
      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repositories-layout',
          title: 'Repositories Layout',
          pages: [
            {
              id: 'repositories',
              kind: 'built-in',
              page: 'repositories',
              title: 'Repositories'
            }
          ],
          navigation: [{ label: 'Explore', pages: ['repositories'] }]
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  const cells = page.locator('.context-summary > div');
  await expect(cells).toHaveCount(3);
  const boxes = await cells.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width } = element.getBoundingClientRect();
    return { x, y, width };
  }));

  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[2].y).toBe(boxes[1].y);
  expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
  expect(boxes[0].x).toBeCloseTo(boxes[1].x, 0);
  expect(boxes[0].x + boxes[0].width).toBeCloseTo(boxes[2].x + boxes[2].width, 0);
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
    transforms: segments.map((segment) => getComputedStyle(segment).transform),
    vectorEffects: segments.map((segment) => getComputedStyle(segment).vectorEffect)
  }));
  expect(segmentGeometry.lengths[0]).toBeCloseTo(62.5, 1);
  expect(segmentGeometry.lengths[1]).toBeCloseTo(37.5, 1);
  expect(segmentGeometry.lengths.reduce((sum, length) => sum + length, 0)).toBeCloseTo(100, 1);
  expect(segmentGeometry.dashArrays).toEqual(['none', 'none']);
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
                  table: false,
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
            { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context.md', 'workflow-name': 'Ambient Context', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 250, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
            { package: 'ambient-context', 'package-name': 'Ambient Context', 'package-icon': 'workflow', workflow: '.github/workflows/ambient-context-worker.md', 'workflow-name': 'Ambient Context Worker', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 800, 'package-aic-allowance': 1050, 'package-inventory-warnings': 0 },
            { package: 'aw-doctor', 'package-name': 'AW Doctor', 'package-icon': 'gear', workflow: '.github/workflows/aw-doctor.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 250, 'package-aic-allowance': 1250, 'package-inventory-warnings': 1 }
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
  await expect(page.locator('.package-utilization-card')).toHaveCount(2);
  await expect(page.locator('[data-package-id="aw-doctor"]')).toContainText('9.6%');
  await expect(page.locator('[data-package-id="aw-doctor"] .octicon-gear')).toBeVisible();
  await expect(page.locator('[data-package-id="ambient-context"]')).toContainText('No AIC usage was reported');
  await expect(page.getByRole('heading', { name: 'All output by package', level: 3 })).toBeVisible();
  await expect(page.locator('.package-trend-panel + .package-summary')).toBeVisible();
  const awDoctorSummary = page.locator('.package-summary-table tbody tr').filter({ hasText: 'AW Doctor' });
  await expect(awDoctorSummary).toContainText('AW Doctor');
  await expect(awDoctorSummary.locator('.octicon-gear')).toBeVisible();
  await expect(awDoctorSummary.locator('td')).toHaveText(['2', '1', '1', '1', '1', '23.9', 'Aug 29, 2026, 10:05 AM']);
  await expect(page.getByRole('heading', { name: 'All runs over time', level: 3 })).toBeVisible();
  await expect(page.locator('.package-chart-point')).toHaveCount(30);
  await expect(page.locator('[data-package-id="ambient-context"] a')).toHaveAttribute('href', '#page-package-insights?package=ambient-context');

  await page.locator('[data-package-id="ambient-context"] a').click();
  await expect(page).toHaveURL(/#page-package-insights\?package=ambient-context$/);
  await expect(page.getByRole('heading', { name: 'Ambient Context', level: 1 })).toBeVisible();
  await expect(page.getByText('No workflow observations yet')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#page-package-detail?package=ambient-context';
  });
  await expect(page.getByRole('heading', { name: 'Ambient Context', level: 1 })).toBeVisible();
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
  const horizonBox = await filterBar.locator('.dashboard-horizon').boundingBox();
  expect(horizonBox).not.toBeNull();
  await expect(filterBar.locator('.filter-tuning-controls')).toBeHidden();
  await filterBar.locator('.horizon-toggle').click();
  const timeRangeBox = await filterBar.locator('.time-window-control').boundingBox();
  expect(timeRangeBox?.y).toBeGreaterThan(horizonBox?.y ?? 0);
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
  await expect(page.getByRole('heading', { name: 'Evals Evals Source' })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Evals Observations Source' }).click();
  await expect(page.getByRole('heading', { name: 'Evals Observations Source' })).toBeVisible();
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
                  table: true,
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
  await expect(page.locator('.custom-chart-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Run 1001' })).toHaveAttribute(
    'href',
    'https://github.com/github/central-agentic-ops/actions/runs/1001'
  );
  await expect(page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Daily Runs' }) }).locator('.view-source')).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'Empty Usage' })).toBeVisible();
  await expect(page.locator('[data-view-availability="empty"]')).toHaveText('No observations matched the effective context.');
  const emptySection = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Empty Usage' }) });
  await expect(emptySection).toContainText('Affected source: empty-usage');

  await expect(page.getByRole('heading', { name: 'Missing Source' })).toBeVisible();
  await expect(page.locator('[data-view-availability="unavailable"]')).toHaveText('This view is unavailable.');
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
                  element: 'workflow-route',
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
                  element: 'workflow-route',
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
  await expect(page.locator('.dashboard-horizon').getByRole('group', { name: 'Data status' })).toContainText('CompletenesscompleteFreshnessfresh');
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
                  element: 'workflow-route',
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
                  element: 'workflow-route',
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
              element: 'workflow-route',
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
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '232px');
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
