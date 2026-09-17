import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'http://ingestion-navigation.dashboard.test';
const asOf = '2026-09-16T22:00:00Z';
const pageDefinitions = [
  ['runs', 'Runs', 'runs', 'run-title'],
  ['repositories', 'Repositories', 'repositories', 'repository'],
  ['workflows', 'Workflows', 'workflows', 'workflow-name']
];
const dashboard = JSON.parse(readFileSync(join(siteRoot, 'dashboard.json'), 'utf8'));
const inventory = {
  repositories: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
    metadata: { 'as-of': asOf }
  },
  workflows: {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      'workflow-name': 'Dashboard'
    }],
    metadata: { 'as-of': asOf }
  }
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} expectedTotal
 */
async function expectRunsLoadOnScroll(page, expectedTotal) {
  const view = page.locator('[data-view-id="runs-runs-source"]');
  const rows = view.locator('tbody > tr');
  const scroll = view.locator('.table-scroll');
  const loadBoundary = view.locator('[data-table-more]');
  await expect(rows).toHaveCount(25);
  await expect(view.locator('.table-filter-result')).toHaveText(`Showing 25 of ${expectedTotal} results`);
  await scroll.hover();
  await page.mouse.wheel(0, 10_000);
  await scroll.evaluate((element) => {
    const scrollElement = /** @type {HTMLElement} */ (element);
    scrollElement.scrollTop = scrollElement.scrollHeight;
  });
  await scroll.dispatchEvent('scroll');
  await expect.poll(() => scroll.evaluate((element) => /** @type {HTMLElement} */ (element).scrollTop)).toBeGreaterThan(0);
  await expect(loadBoundary).toHaveText('Load more rows');
  await expect.poll(() => rows.count()).toBeGreaterThan(25);
}

/** @param {import('@playwright/test').Page} page */
async function storedRunCount(page) {
  return page.evaluate(async (storageUrl) => {
    const { readCollection } = await import(storageUrl);
    return (await readCollection(indexedDB, 'runs')).length;
  }, `${origin}/src/data/storage/indexeddb.js`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} pageId
 */
async function navigateToPage(page, pageId) {
  await page.evaluate((nextPageId) => {
    const link = document.querySelector(`[data-nav-page-id="${nextPageId}"]`);
    if (!(link instanceof HTMLAnchorElement)) throw new Error(`Missing navigation link for ${nextPageId}.`);
    link.click();
  }, pageId);
}

test('Runs lazy list loads on scroll during and after activity ingestion', async ({ context, page }) => {
  const shardCount = 12;
  const runsPerShard = 10;
  let requestedShards = 0;
  let completedShards = 0;
  let releaseFinalShard = () => {};
  const finalShardReady = new Promise((resolve) => {
    releaseFinalShard = () => resolve(undefined);
  });
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<div id="root"></div><script type="module" src="./src/main.js"></script>'
      });
      return;
    }
    if (url.pathname === '/dashboard.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(dashboard) });
      return;
    }
    if (url.pathname === '/inventory-sources.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(inventory) });
      return;
    }
    if (url.pathname === '/payload-hashes.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(Object.fromEntries(
          Array.from({ length: shardCount }, (_, index) => [
           `gh-aw-logs-shards/logs-${String(index + 1).padStart(2, '0')}.jsonl`,
            String(index + 1).padStart(64, 'a')
          ])
        ))
      });
      return;
    }
    const shard = /^\/gh-aw-logs-shards\/logs-(\d+)\.jsonl$/.exec(url.pathname);
    if (shard) {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ headers: { 'content-length': '512' }, body: '' });
        return;
      }
      requestedShards += 1;
      await new Promise((resolve) => setTimeout(resolve, 35));
      const run = Number(shard[1]);
      if (run === shardCount) await finalShardReady;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: `${Array.from({ length: runsPerShard }, (_, index) => JSON.stringify({
          schema_version: 2,
          kind: 'run',
          run: {
            run_id: 1000 + (run - 1) * runsPerShard + index + 1,
            run_attempt: 1,
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow_name: 'Dashboard',
            workflow_path: '.github/workflows/dashboard.md',
            display_title: `Ingested run ${run}-${index + 1}`,
            status: 'completed',
            conclusion: 'success',
            created_at: asOf,
            updated_at: asOf
          }
        })).join('\n')}\n`
      });
      completedShards += 1;
      return;
    }
    const filePath = join(siteRoot, url.pathname);
    if (existsSync(filePath)) {
      await route.fulfill({
        contentType: url.pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(filePath)
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });

  await page.goto(`${origin}/`);
  await expect.poll(() => completedShards).toBe(shardCount - 1);
  await expect.poll(() => storedRunCount(page)).toBe((shardCount - 1) * runsPerShard);
  await page.locator('.dashboard-notification-toggle').click();
  await page.getByRole('button', { name: 'Sync queries', exact: true }).click();
  await navigateToPage(page, 'runs');
  await page.getByRole('button', { name: 'Show table view' }).click();
  await expect(page.locator('td[data-field="run"]', { hasText: '1001' })).toBeVisible();
  expect(completedShards).toBeLessThan(shardCount);
  await expect(page.locator('.loading-progress')).toBeVisible();
  await expectRunsLoadOnScroll(page, completedShards * runsPerShard);

  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (const [id, title] of pageDefinitions) {
      await navigateToPage(page, id);
      await expect(page.locator('#page-title')).toHaveText(title);
    }
  }

  releaseFinalShard();
  await expect.poll(() => storedRunCount(page)).toBe(shardCount * runsPerShard);
  await navigateToPage(page, 'runs');
  expect(requestedShards).toBe(shardCount);
  await expectRunsLoadOnScroll(page, shardCount * runsPerShard);
});
