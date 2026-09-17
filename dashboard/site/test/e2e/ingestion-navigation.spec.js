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
const dashboard = {
  'language-version': '0.1.0',
  dashboard: {
    id: 'ingestion-navigation',
    title: 'Ingestion navigation',
    pages: pageDefinitions.map(([id, title, source, field]) => ({
      id,
      kind: 'custom',
      title,
      views: [{
        id: `${id}-table`,
        title,
        data: { source },
        mark: 'table',
        encoding: { columns: [{ field, type: 'nominal', title }] }
      }]
    }))
  }
};
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

test('views remain interactive while activity shards are ingested', async ({ context, page }) => {
  const shardCount = 12;
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
        body: `${JSON.stringify({
          schema_version: 2,
          kind: 'run',
          run: {
            run_id: 1000 + run,
            run_attempt: 1,
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow_name: 'Dashboard',
            workflow_path: '.github/workflows/dashboard.md',
            display_title: `Ingested run ${run}`,
            status: 'completed',
            conclusion: 'success',
            created_at: asOf,
            updated_at: asOf
          }
        })}\n`
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
  await expect.poll(() => requestedShards).toBeGreaterThan(0);
  await expect(page.getByRole('cell', { name: 'Ingested run 1', exact: true })).toBeVisible();
  expect(completedShards).toBeLessThan(shardCount);
  await expect(page.locator('.loading-progress')).toBeVisible();

  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (const [, title] of pageDefinitions) {
      await page.getByRole('link', { name: title, exact: true }).click();
      await expect(page.locator('#page-title')).toHaveText(title);
    }
  }

  releaseFinalShard();
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Ingested run 12' })).toBeVisible();
  expect(requestedShards).toBe(shardCount);
});
