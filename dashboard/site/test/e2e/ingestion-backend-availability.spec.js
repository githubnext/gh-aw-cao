import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import { splitDashboardDocument } from '../../src/dashboard-chunks.js';
import { normalizedRunShard } from './normalized-shard.js';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'http://ingestion-backend.dashboard.test';
const asOf = '2026-09-24T00:00:00Z';
const hash = 'a'.repeat(64);
const shardName = `gh-aw-logs-runs/logs-${hash}-${'b'.repeat(16)}.jsonl`;
const contract = JSON.parse(readFileSync(join(siteRoot, 'test/fixtures/ingestion-backend-contract.json'), 'utf8'));
const pageDefinition = authoritativeDashboard.dashboard.pages.find(
  (/** @type {{ id: string }} */ page) => page.id === contract.page
);
const { core, pageChunks } = splitDashboardDocument({
  ...authoritativeDashboard,
  dashboard: {
    ...authoritativeDashboard.dashboard,
    pages: [pageDefinition],
    navigation: [{ pages: [contract.page] }],
    callouts: undefined
  }
});

test('static Ingestion queries retained canonical evidence but not hosted telemetry', async ({ context, page }) => {
  await page.addInitScript(() => {
    const prototype = Worker.prototype;
    const post = prototype.postMessage;
    /** @type {Array<{ operation: string, sourceNames?: string[] }>} */
    const requests = [];
    Object.assign(window, { dashboardWorkerRequests: requests });
    prototype.postMessage = function (message, ...options) {
      if (message && typeof message.operation === 'string') {
        requests.push({ operation: message.operation, sourceNames: message.sourceNames });
      }
      return Reflect.apply(post, this, [message, ...options]);
    };
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
      await route.fulfill({ json: core });
      return;
    }
    if (url.pathname === `/dashboard-pages/${contract.page}.json`) {
      await route.fulfill({ json: pageChunks.get(contract.page) });
      return;
    }
    if (url.pathname === '/payload-hashes.json') {
      await route.fulfill({ json: { [shardName]: hash } });
      return;
    }
    if (url.pathname === '/inventory-sources.json') {
      await route.fulfill({
        json: {
          repositories: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }], metadata: { 'as-of': asOf } },
          workflows: {
            rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'dashboard.md', 'workflow-name': 'Dashboard' }],
            metadata: { 'as-of': asOf }
          }
        }
      });
      return;
    }
    if (url.pathname === `/${shardName}`) {
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: route.request().method() === 'HEAD' ? '' : normalizedRunShard(`${JSON.stringify({
          schema_version: 2, kind: 'run',
          run: {
            run_id: 3001, run_attempt: 1, organization: 'githubnext', repository: 'gh-aw-cao',
            workflow_path: 'dashboard.md', workflow_name: 'Dashboard', status: 'completed',
            conclusion: 'success', created_at: asOf, updated_at: asOf
          }
        })}\n`)
      });
      return;
    }
    const path = join(siteRoot, url.pathname);
    if (existsSync(path)) {
      await route.fulfill({
        contentType: path.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(path)
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto(`${origin}/#page-indexing`);
  await expect(page.locator('[data-view-id="indexing-database-table-counts"] [data-chart-widget="horizontal-bar"]')).toBeVisible();
  for (const id of contract.hostedViews) {
    const view = page.locator(`[data-view-id="${id}"]`);
    await expect(view).toHaveAttribute('data-view-backend-unavailable', '');
    await expect(view.locator('[data-view-availability="unavailable"]')).toContainText('hosted CAO backend');
    await expect(view.locator('[data-view-state]')).toHaveAttribute('role', 'alert');
  }
  const requests = await page.evaluate(() => /** @type {Window & { dashboardWorkerRequests?: Array<{ sourceNames?: string[] }> }} */ (window).dashboardWorkerRequests ?? []);
  const sources = requests.flatMap((request) => request.sourceNames ?? []);
  for (const source of contract.hostedSources) expect(sources).not.toContain(source);
  expect(sources).not.toContain('collection-health');
  expect(sources).not.toContain('github-quota-usage');
  expect(sources).toContain('indexing-database-table-counts');
});
