import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

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

test('mobile title bar keeps the dashboard subtitle adjacent to the page title', async ({ page }) => {
  const adjacentTitleGapTolerancePx = 2;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async (presenterModuleUrl) => {
    const { renderDashboard } = await import(presenterModuleUrl);
    document.querySelector('#root')?.append(renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'mobile-title-dashboard',
          title: 'gh-aw-cao',
          repository: 'githubnext/gh-aw-cao',
          pages: [
            { id: 'overview', kind: 'custom', title: 'Overview', description: 'Operational dashboard', views: [], sections: [] }
          ]
        }
      },
      sources: {}
    }));
  }, 'http://dashboard.test/src/presenter.js');

  const mobileHeader = page.locator('.mobile-page-header');
  await expect(mobileHeader.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(mobileHeader.locator('.mobile-brand-name')).toHaveText('gh-aw-cao');
  await expect(mobileHeader.locator('[data-page-description]')).toHaveAttribute('aria-hidden', 'true');

  const titleGap = await mobileHeader.evaluate((element) => {
    const title = element.querySelector('h1')?.getBoundingClientRect();
    const subtitle = element.querySelector('.mobile-brand-name')?.getBoundingClientRect();
    if (!title || !subtitle) return Number.POSITIVE_INFINITY;
    return subtitle.top - title.bottom;
  });
  expect(titleGap).toBeLessThanOrEqual(adjacentTitleGapTolerancePx);
});

test('notifications move in at the lower right and center on mobile', async ({ page }) => {
  await page.setContent(`
    <style id="notification-styles"></style>
    <script type="module">
      import { getPrimerStyles } from 'http://dashboard.test/src/styles.js';
      import { publishNotification } from 'http://dashboard.test/src/notification-service.js';
      document.querySelector('#notification-styles').textContent = getPrimerStyles();
      publishNotification({ message: 'Dashboard refreshed.', duration: 0 });
    </script>
  `);

  const notifications = page.locator('.dashboard-notifications');
  await expect(notifications).toBeVisible();
  await expect(notifications).toHaveCSS('right', '16px');
  await expect(notifications).toHaveCSS('width', '480px');
  await expect(page.locator('.dashboard-notification')).toHaveCSS('opacity', '1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notifications).toHaveCSS('width', '358px');
  const bounds = await notifications.boundingBox();
  expect(bounds).not.toBeNull();
  expect(Math.abs((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2 - 195)).toBeLessThan(1);
});

test('issue card labels stay compact with centered text and balanced padding', async ({ page }) => {
  await page.setContent(`
    <style id="dashboard-styles"></style>
    <ul class="issue-list-labels" style="width: 240px; height: 80px">
      <li>unknown</li>
    </ul>
    <script type="module">
      import { getPrimerStyles } from 'http://dashboard.test/src/styles.js';
      document.querySelector('#dashboard-styles').textContent = getPrimerStyles();
    </script>
  `);

  const label = page.locator('.issue-list-labels li');
  await expect(label).toHaveCSS('height', '20px');
  await expect(label).toHaveCSS('padding-left', '9px');
  await expect(label).toHaveCSS('padding-right', '9px');
  await expect(label).toHaveCSS('text-align', 'center');

  const centers = await label.evaluate((element) => {
    const labelBounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const textBounds = range.getBoundingClientRect();
    return {
      labelX: labelBounds.x + labelBounds.width / 2,
      labelY: labelBounds.y + labelBounds.height / 2,
      textX: textBounds.x + textBounds.width / 2,
      textY: textBounds.y + textBounds.height / 2,
    };
  });

  expect(Math.abs(centers.textX - centers.labelX)).toBeLessThanOrEqual(1);
  expect(Math.abs(centers.textY - centers.labelY)).toBeLessThanOrEqual(1);
});

test('campaign card actions wrap together on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async (moduleUrls) => {
    const [stylesUrl, dataViewUrl, cliActionsUrl] = moduleUrls;
    const [{ getPrimerStyles }, { renderDataView }, { setDeclaredCliActions }] = await Promise.all([
      import(stylesUrl),
      import(dataViewUrl),
      import(cliActionsUrl)
    ]);
    document.head.append(Object.assign(document.createElement('style'), { textContent: getPrimerStyles() }));
    setDeclaredCliActions([
      { id: 'update', label: 'Update', icon: 'sync', command: 'gh aw update {{campaign}}', placement: 'row' },
      { id: 'live', label: 'Switch to live', icon: 'play', command: 'gh aw mode live {{campaign}}', placement: 'row' },
      { id: 'enable', label: 'Enable', icon: 'play', command: 'gh aw enable {{campaign}}', placement: 'row' },
      { id: 'disable', label: 'Disable', icon: 'stop', command: 'gh aw disable {{campaign}}', placement: 'row' }
    ], { canExecute: false });
    const view = renderDataView('list', {
      pageId: 'maintenance',
      title: 'Campaigns',
      view: {
        mark: 'list',
        list: { style: 'cards', icon: 'goal' },
        encoding: {
          columns: [{ field: 'campaign-name', title: 'Campaign' }],
          actions: [
            { action: 'update', presentation: 'cli-action', icon: 'sync', label: 'Update', context: ['campaign'] },
            { action: 'live', presentation: 'cli-action', icon: 'play', label: 'Switch to live', context: ['campaign'] },
            { action: 'enable', presentation: 'cli-action', icon: 'play', label: 'Enable', context: ['campaign'] },
            { action: 'disable', presentation: 'cli-action', icon: 'stop', label: 'Disable', context: ['campaign'] }
          ]
        }
      },
      sourceName: 'campaigns',
      rows: [{ campaign: 'aw-optimization', 'campaign-name': 'AW Optimization' }],
      metadata: { 'source-id': 'fixture', 'source-kind': 'fixture', 'as-of': '2026-09-18T00:00:00Z', 'retrieved-at': '2026-09-18T00:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
      contextDetails: [],
      headingTag: 'h3',
      prepareTableRows: (/** @type {Array<Record<string, unknown>>} */ rows) => rows,
      buildChartPoints: () => [],
      prepareChartPoints: () => [],
      toText: String
    });
    document.body.append(view);
  }, [
    'http://dashboard.test/src/styles.js',
    'http://dashboard.test/src/components/data-view.js',
    'http://dashboard.test/src/components/cli-actions.js'
  ]);

  const actions = page.locator('.document-list-card-actions');
  await expect(actions).toHaveCount(1);
  await expect(actions.locator('.table-cli-action-control')).toHaveCount(4);
  const [actionsBox, controlBox] = await Promise.all([
    actions.boundingBox(),
    actions.locator('.table-cli-action-control').first().boundingBox()
  ]);
  expect(actionsBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  if (actionsBox === null || controlBox === null) throw new Error('Expected visible campaign actions.');
  const maxWrappedRows = 2;
  const actionGap = 6;
  expect(actionsBox.height).toBeLessThanOrEqual(controlBox.height * maxWrappedRows + actionGap);
});
