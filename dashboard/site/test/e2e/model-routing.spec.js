import { test, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { normalizedActivityShards } from './normalized-shard.js';

for (const dataBackend of ['indexeddb', 'sqlite']) {
  test.describe(`${dataBackend} model routing`, () => {
    /** @type {{ url: string, close: () => Promise<void> }} */
    let server;
    let workspace = '';

    test.beforeAll(async () => {
      const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);
      workspace = await mkdtemp(fileURLToPath(new URL('../../../../.cao-routing-e2e-', import.meta.url)));
      const siteRoot = fileURLToPath(new URL('../../', import.meta.url));
      await cp(siteRoot, join(workspace, 'site'), {
        recursive: true,
        filter: (path) => !['node_modules', 'dist', '.tmp', 'test', 'test-results', 'scripts'].includes(relative(siteRoot, path).split(sep)[0])
      });
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      /** @param {string} type @param {Record<string, unknown>} data @param {string} [phase] */
      const event = (type, data, phase = 'agent') => ({ type, data, provenance: { phase, timestampMs: now, component: 'awf' } });
      const document = parseUnifiedSessionDocument([
        { type: 'session.format', data: { version: 1 } },
        event('workflow.info', { repository: 'octo/api', runId: 101, engineId: 'copilot' }),
        event('model.config', { routing: { enabled: true } }),
        event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high',
          objective: { goal: 'cost', mode: 'auto' }, mode: 'balanced',
          labels: { task_type: 'coding', scope: 'repository', task_complexity: 'high' } }),
        event('firewall.model_routing', { stage: 'request', requestId: 'request-1', requestedModel: 'gpt-5',
          selectedModel: 'gpt-5', routed: 'as_selected', outcome: 'success' }),
        event('firewall.token_usage', { requestId: 'request-1', model: 'gpt-5', aic: 4 }),
        event('workflow.job_result', { jobId: 'agent', result: 'success' }),
        event('session.collection', { sources: [{ path: 'firewall/agent/token-usage.jsonl', phase: 'agent', component: 'firewall', events: 1 }] }, 'conclusion')
      ].map((row) => JSON.stringify(row)).join('\n'), 'usage/aw_session.jsonl', { runId: '101', attempt: 1 });
      const shards = normalizedActivityShards(JSON.stringify({
        schema_version: 5, kind: 'run',
        run: { run_id: 101, run_attempt: 1, organization: 'octo', repository: 'octo/api',
          workflow_name: 'Routing worker', workflow_path: '.github/workflows/worker.lock.yml',
          created_at: timestamp, updated_at: timestamp, status: 'completed', conclusion: 'success',
          cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', ...document } }
      }));
      server = await startDashboardServer({
        workingDirectory: workspace, siteRoot: join(workspace, 'site'), catalogRoot: null,
        port: 0, canvas: true, dataBackend,
        output: () => {}, requestOutput: () => {}, traceOutput: () => {},
        executeCliAction: async () => { throw new Error('CLI actions are disabled in routing browser tests.'); },
        approveCliAction: async () => false,
        downloadData: async (/** @type {string} */ destination) => {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify({
            repositories: { rows: [{ organization: 'octo', repository: 'api', 'observed-at': timestamp }],
              metadata: { 'as-of': timestamp, 'artifact-generation': 'routing-e2e' } }
          }));
          for (const phase of /** @type {const} */ (['runs', 'records'])) {
            const directory = join(destination, `gh-aw-logs-${phase}`);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, `logs-101-${'a'.repeat(64)}-${'1'.repeat(16)}.jsonl`), shards[phase]);
          }
        }
      });
    });
    test.afterAll(async () => {
      await server?.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    });

    for (const width of [1280, 390]) {
      test(`renders populated routing and drill-down at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${server.url}/?local-preview=canvas#page-model-routing`);
        await expect(page.getByRole('dialog', { name: 'Preparing your dashboard' })).toBeHidden();
        await expect(page.getByRole('heading', { name: 'Adoption', exact: true })).toBeVisible();
        const runs = page.locator('[data-view-id="routing-runs"]');
        await expect(runs).toContainText('selected');
        await expect(runs).toContainText('gpt-5');
        const screenshot = testInfo.outputPath(`model-routing-${dataBackend}-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach(`model-routing-${dataBackend}-${width}`, { path: screenshot, contentType: 'image/png' });
        const state = page.getByRole('textbox', { name: 'Routing state', exact: true });
        await state.fill('unrouted');
        await expect(runs).toContainText('No identified routing sessions');
        await state.fill('');
        await expect(runs).toContainText('selected');
        if (width < 768) {
          for (let step = 0; step < 2; step += 1) {
            await page.locator('.mobile-view-mode-toggle').click();
            if (await page.locator('.dashboard-page:not([hidden])').getAttribute('data-view-mode') === 'table') break;
          }
        } else await page.getByRole('button', { name: 'Table', exact: true }).click();
        await runs.locator('a[href*="routing-run="]').click();
        await expect(page.getByRole('heading', { name: 'Agent-phase accounting coverage', exact: true })).toBeVisible();
        await expect(page.locator('[data-view-id="routing-run-attribution"]')).toContainText('main_agent');
        await expect(page.locator('[data-view-id="routing-run-requests"]')).toContainText('as_selected');
        await expect(page.locator('[data-view-id="routing-run-timeline"]')).toContainText('firewall.model_routing');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }
  });
}
