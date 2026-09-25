import { DATABASE_NAME, buildPresenterModuleUrl, devices, expect, readFileSync, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

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
