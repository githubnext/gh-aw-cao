import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { normalizedActivityShards } from './normalized-shard.js';
import { originalSessions, replay, runCacheLine } from '../model-resolution-fixture.js';
import { publishNativeFixture } from '../../../../tests/helpers/native-dashboard.mjs';
import { startDashboardSiteFixture } from '../../../../tests/e2e/dashboard-site-fixture.mjs';

/**
 * Serves a copy of the site with the supplied normalized activity shards.
 * @param {string} dataBackend @param {{ runs: string, records: string }} shards @param {string} run @param {string} timestamp
 * @param {string} [repository]
 */
async function startRoutingServer(dataBackend, shards, run, timestamp, repository = 'octo/api') {
  const [organization, name] = repository.split('/');
  /** @type {{ url: string, close: () => Promise<void> }} */
  const server = await startDashboardSiteFixture({
    catalogRoot: null,
    port: 0, canvas: true, dataBackend,
    output: () => {}, requestOutput: () => {}, traceOutput: () => {},
    approveCliAction: async () => false,
    downloadData: publishNativeFixture(async (/** @type {string} */ destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify({
        repositories: { rows: [{ organization, repository: name, 'observed-at': timestamp }],
          metadata: { 'as-of': timestamp, 'artifact-generation': 'routing-e2e' } }
      }));
      for (const phase of /** @type {const} */ (['runs', 'records'])) {
        const directory = join(destination, `gh-aw-logs-${phase}`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `logs-${run}-${'a'.repeat(64)}-${'1'.repeat(16)}.jsonl`), shards[phase]);
      }
    })
  });
  return server;
}

for (const dataBackend of ['indexeddb', 'sqlite']) {
  test.describe(`${dataBackend} model routing`, () => {
    /** @type {{ url: string, close: () => Promise<void> }} */
    let server;
    test.beforeAll(async () => {
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
      server = await startRoutingServer(dataBackend, shards, '101', timestamp);
    });
    test.afterAll(async () => {
      await server?.close();
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

for (const dataBackend of ['indexeddb', 'sqlite']) {
  test.describe(`${dataBackend} model resolution`, () => {
    /** @type {{ url: string, close: () => Promise<void> }} */
    let server;
    test.beforeAll(async () => {
      const now = Date.now();
      // Minimized real smoke sessions plus documented controlled replays (alias move and failures).
      const sessions = [...originalSessions, replay('opus-before'), replay('opus-after'),
        replay('pi-main-model-unavailable'), replay('pi-main-catalog-unavailable')];
      const shards = normalizedActivityShards(sessions.map((source) => runCacheLine(source, now)).join('\n'));
      server = await startRoutingServer(dataBackend, shards, '39091103540', new Date(now).toISOString(), 'github/gh-aw');
    });
    test.afterAll(async () => {
      await server?.close();
    });

    for (const width of [1280, 390]) {
      test(`renders Model resolution and run resolution drill-down at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${server.url}/?local-preview=canvas#page-model-routing`);
        await expect(page.getByRole('dialog', { name: 'Preparing your dashboard' })).toBeHidden();
        if (width < 768) {
          for (let step = 0; step < 2; step += 1) {
            await page.locator('.mobile-view-mode-toggle').click();
            if (await page.locator('.dashboard-page:not([hidden])').getAttribute('data-view-mode') === 'table') break;
          }
        } else await page.getByRole('button', { name: 'Table', exact: true }).click();
        /** @param {string} id */
        const section = async (id) => {
          const disclosure = page.locator('details', { has: page.locator(`[data-view-id="${id}"]`) });
          if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().press('Enter');
          return page.locator(`[data-view-id="${id}"]`);
        };
        const coverage = await section('routing-resolution-coverage');
        await expect(coverage).toContainText('Routed without resolution');
        const moves = await section('routing-alias-moves');
        await expect(moves).toContainText('alias moved');
        await expect(moves).toContainText('claude-opus-5 → claude-opus-5.5');
        await expect(moves).toContainText('claude-haiku-5.5');
        const failures = await section('routing-resolution-failures');
        await expect(failures).toContainText('model_unavailable');
        await expect(failures).toContainText('catalog_unavailable');
        await expect(failures).toContainText('copilot/gpt-5.3');
        const screenshot = testInfo.outputPath(`model-resolution-${dataBackend}-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach(`model-resolution-${dataBackend}-${width}`, { path: screenshot, contentType: 'image/png' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        const engine = page.getByRole('textbox', { name: 'Engine', exact: true });
        await engine.fill('codex');
        await expect(moves).not.toContainText('claude-opus-5.5');
        await expect(moves).toContainText('auto');
        await expect(failures).toContainText('No failed configured-model resolution was recorded');
        await engine.fill('');
        await expect(failures).toContainText('model_unavailable');

        await section('routing-resolution-failures');
        await failures.locator('a[href*="routing-run=github%2Fgh-aw%3A990000003"]:visible').first().click();
        await expect(page).toHaveURL(/#page-routing-run\?routing-run=github%2Fgh-aw%3A990000003$/);
        const drill = await section('routing-run-resolutions');
        await expect(drill).toContainText('copilot/gpt-5.3 → unknown');
        await expect(drill).toContainText('model_unavailable');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }
  });
}
