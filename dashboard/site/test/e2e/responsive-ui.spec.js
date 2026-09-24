import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const dashboardDocument = JSON.parse(readFileSync(join(siteRoot, 'dashboard.json'), 'utf8'));

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

test('notification filters and view controls are hidden on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async ({ documentModel, presenterModuleUrl }) => {
    const { renderDashboard } = await import(presenterModuleUrl);
    document.querySelector('#root')?.append(renderDashboard({
      document: documentModel,
      sources: {
        'overview-needs-attention': {
          source: 'overview-needs-attention',
          rows: [{
            title: 'Failed workflow',
            reason: 'Two runs failed.',
            tone: 'critical'
          }],
          metadata: {
            'source-id': 'fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-20T00:00:00Z',
            'retrieved-at': '2026-09-20T00:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    }));
  }, {
    documentModel: {
      'language-version': dashboardDocument['language-version'],
      dashboard: {
        id: 'notifications-mobile',
        title: 'Notifications',
        'card-templates': dashboardDocument.dashboard['card-templates'],
        pages: [dashboardDocument.dashboard.pages.find(
          /** @param {{ id?: string }} page */
          (page) => page.id === 'notifications'
        )]
      }
    },
    presenterModuleUrl: 'http://dashboard.test/src/presenter.js'
  });

  const notifications = page.locator('[data-page-id="notifications"]');
  await expect(notifications).toHaveClass(/notifications-page/);
  await expect(notifications.locator(':scope > .page-chrome > .filter-bar')).toBeHidden();
  await expect(notifications.locator('.view-mode-control')).toBeHidden();
  await expect(notifications.locator('.entity-card-list-status-danger .octicon-x-circle-fill')).toBeVisible();
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

test('full-view content keeps a responsive horizontal inset', async ({ page }) => {
  const styles = await page.evaluate(async (stylesUrl) => {
    const { getPrimerStyles } = await import(stylesUrl);
    return getPrimerStyles();
  }, 'http://dashboard.test/src/styles.js');
  await page.setContent(`
    <style>${styles}</style>
    <div class="dashboard-root dashboard-full-view">
      <div class="app-shell">
        <aside class="org-sidebar"></aside>
        <div class="app-main">
          <div class="top-nav"><div class="shell">Campaigns</div></div>
          <div class="site-callouts"><div data-callout>Refresh warning</div></div>
          <main class="dashboard-prototype">
            <div class="report-body" data-page-content>Campaigns content</div>
          </main>
        </div>
      </div>
    </div>
  `);

  const contentLayout = () => page.locator('main.dashboard-prototype').evaluate((main) => {
    const content = main.querySelector('[data-page-content]');
    if (!(content instanceof HTMLElement)) throw new Error('Expected page content.');
    const mainBounds = main.getBoundingClientRect();
    const contentBounds = content.getBoundingClientRect();
    return {
      left: contentBounds.left - mainBounds.left,
      right: mainBounds.right - contentBounds.right,
      top: contentBounds.top - mainBounds.top,
      bottom: mainBounds.bottom - contentBounds.bottom,
      scrollbarGutter: getComputedStyle(main).scrollbarGutter
    };
  });

  // The full-view modifier replaces the default stable gutter while preserving full-height content.
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(contentLayout).toEqual({
    left: 24,
    right: 24,
    top: 0,
    bottom: 0,
    scrollbarGutter: 'auto'
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(contentLayout).toEqual({
    left: 14,
    right: 14,
    top: 0,
    bottom: 0,
    scrollbarGutter: 'auto'
  });
});

const horizontalBarFixtureLabel = '.github/workflows/extremely-long-dependabot-update-planner.md';
const horizontalBarFixtureSuffix = 'planner.md';

/** @param {import('@playwright/test').Page} page */
async function renderHorizontalBarFixture(page) {
  await page.setContent(`
    <style id="dashboard-styles"></style>
    <main class="chart-stage" style="width: 220px"></main>
    <script type="module">
      import { getPrimerStyles } from 'http://dashboard.test/src/styles.js';
      import { renderChartWidget } from 'http://dashboard.test/src/components/chart-elements.js';
      document.querySelector('#dashboard-styles').textContent = getPrimerStyles();
      document.querySelector('.chart-stage').append(renderChartWidget('horizontal-bar', [
        { x: ${JSON.stringify(horizontalBarFixtureLabel)}, y: 27 }
      ], [{ name: 'value', className: 'chart-series-1' }]));
    </script>
  `);
}

/**
 * @param {import('@playwright/test').Locator} row
 * @param {string} suffix
 * @returns {Promise<{
 *   overflowed: boolean,
 *   overflowAmount: number,
 *   firstCharClipDistance: number,
 *   suffixLeft: number,
 *   suffixRight: number,
 *   labelLeft: number,
 *   labelRight: number,
 *   text: string,
 *   textOverflowed: boolean,
 *   textRight: number
 * }>}
 */
async function measureHorizontalBarLabel(row, suffix) {
  return row.evaluate((
    /** @type {Element} */ rowElement,
    /** @type {string} */ expectedSuffix
  ) => {
    const labelElement = rowElement.querySelector('.horizontal-bar-chart-label');
    const textElement = rowElement.querySelector('.horizontal-bar-chart-label-text');
    const textNode = [...(textElement?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE);
    if (!labelElement || typeof labelElement.getBoundingClientRect !== 'function') {
      throw new Error('Expected horizontal bar label element.');
    }
    if (!textNode) {
      throw new Error('Expected horizontal bar label text node.');
    }
    if (!textElement || typeof textElement.getBoundingClientRect !== 'function') {
      throw new Error('Expected horizontal bar label text element.');
    }
    const text = textNode.textContent ?? '';
    const suffixStart = text.lastIndexOf(expectedSuffix);
    if (suffixStart < 0) throw new Error('Expected label suffix.');
    const suffixRange = document.createRange();
    suffixRange.setStart(textNode, suffixStart);
    suffixRange.setEnd(textNode, suffixStart + expectedSuffix.length);
    const firstCharRange = document.createRange();
    firstCharRange.setStart(textNode, 0);
    firstCharRange.setEnd(textNode, 1);
    const labelBounds = labelElement.getBoundingClientRect();
    const textBounds = textElement.getBoundingClientRect();
    const suffixBounds = suffixRange.getBoundingClientRect();
    const firstCharBounds = firstCharRange.getBoundingClientRect();
    return {
      overflowed: labelElement.scrollWidth > labelElement.clientWidth,
      overflowAmount: labelElement.scrollWidth - labelElement.clientWidth,
      firstCharClipDistance: labelBounds.left - firstCharBounds.right,
      suffixLeft: suffixBounds.left,
      suffixRight: suffixBounds.right,
      labelLeft: labelBounds.left,
      labelRight: labelBounds.right,
      text: textElement.textContent ?? '',
      textOverflowed: textElement.scrollWidth > textElement.clientWidth,
      textRight: textBounds.right
    };
  }, suffix);
}

test('mobile horizontal bar labels preserve readable suffixes', async ({ page }) => {
  // Keep the fixture narrow enough that the prefix is substantially clipped,
  // while allowing a subpixel edge tolerance for browser font rendering.
  const meaningfulPrefixOverflowPx = 20;
  // Require visible clipping proportional to measured overflow without tying
  // the assertion to exact glyph widths.
  const firstCharClipOverflowDivisor = 4;
  await page.setViewportSize({ width: 390, height: 844 });
  await renderHorizontalBarFixture(page);

  const firstRow = page.locator('.horizontal-bar-chart-row').first();
  const label = firstRow.locator('.horizontal-bar-chart-label');
  await expect(label).toBeVisible();
  await expect(label).toHaveCSS('direction', 'rtl');
  await expect(label.locator('.horizontal-bar-chart-label-text')).toHaveCSS('direction', 'ltr');

  const labelRendering = await measureHorizontalBarLabel(firstRow, horizontalBarFixtureSuffix);

  expect(labelRendering.overflowed).toBe(true);
  expect(labelRendering.overflowAmount).toBeGreaterThan(meaningfulPrefixOverflowPx);
  expect(labelRendering.firstCharClipDistance)
    .toBeGreaterThan(labelRendering.overflowAmount / firstCharClipOverflowDivisor);
  expect(labelRendering.suffixLeft).toBeGreaterThanOrEqual(labelRendering.labelLeft);
  expect(labelRendering.suffixRight).toBeLessThanOrEqual(labelRendering.labelRight);
});

test('desktop horizontal bar labels keep standard end truncation', async ({ page }) => {
  const expectedVisiblePrefix = '.github';
  await page.setViewportSize({ width: 900, height: 700 });
  await renderHorizontalBarFixture(page);

  const firstRow = page.locator('.horizontal-bar-chart-row').first();
  const label = firstRow.locator('.horizontal-bar-chart-label');
  await expect(label).toBeVisible();
  await expect(label).toHaveCSS('direction', 'ltr');
  await expect(label.locator('.horizontal-bar-chart-label-text')).toHaveCSS('display', 'block');

  const labelRendering = await measureHorizontalBarLabel(firstRow, horizontalBarFixtureSuffix);

  expect(labelRendering.text.startsWith(expectedVisiblePrefix)).toBe(true);
  expect(labelRendering.textOverflowed).toBe(true);
  expect(labelRendering.suffixRight).toBeGreaterThan(labelRendering.textRight);
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
      rows: [{ campaign: 'aw-optimization', 'campaign-name': 'Optimization' }],
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
