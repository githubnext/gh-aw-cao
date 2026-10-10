import { test, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import previewDocument from '../fixtures/query-editor.json' with { type: 'json' };
import sources from '../fixtures/query-editor-sources.json' with { type: 'json' };
import { normalizedRunShard } from './normalized-shard.js';

/** @type {{ url: string, close: () => Promise<void> }} */
let server;
let workspace = '';

test.beforeAll(async () => {
  const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);
  workspace = await mkdtemp(fileURLToPath(new URL('../../../../.cao-dashboard-e2e-', import.meta.url)));
  const siteRoot = fileURLToPath(new URL('../../', import.meta.url));
  await cp(siteRoot, join(workspace, 'site'), {
    recursive: true,
    filter: (path) => !['node_modules', 'dist', '.tmp', 'test', 'test-results', 'scripts'].includes(path.slice(siteRoot.length + 1).split('/')[0])
  });
  server = await startDashboardServer({
    workingDirectory: workspace,
    siteRoot: join(workspace, 'site'),
    catalogRoot: null, port: 0, canvas: true,
    output: () => {}, requestOutput: () => {}, traceOutput: () => {},
    executeCliAction: async () => ({}), approveCliAction: async () => false,
    generateQuery: async () => ({ document: JSON.stringify(previewDocument, null, 2) }),
    enhanceQueryIntent: async (/** @type {Record<string, string>} */ request) => Object.fromEntries(
      ['intent', 'subject', 'objective', 'acceptance'].map((name) => [name, `Enhanced ${name}: ${request[name] || 'measurable criteria'}`])
    ),
    downloadData: async (/** @type {string} */ destination) => {
      await mkdir(destination, { recursive: true });
      await mkdir(join(destination, 'gh-aw-logs-runs'), { recursive: true });
      await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify(sources));
      await writeFile(join(destination, 'gh-aw-logs-runs', `logs-1-${'a'.repeat(64)}-${'1'.repeat(16)}.jsonl`),
        normalizedRunShard(await readFile(new URL('../fixtures/query-editor-runs.jsonl', import.meta.url), 'utf8')));
    },
  });
});
test.afterAll(async () => {
  await server?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** @param {import('@playwright/test').Page} page */
async function openEditor(page) {
  await page.goto(`${server.url}/?local-preview=canvas#page-query-editor`);
  await expect(page.locator('.dashboard-current-status .tooltip-trigger')).toHaveAttribute('aria-label', 'Dashboard data is current');
  await expect(page.getByRole('textbox', { name: 'Intent', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Preparing your dashboard' })).toBeHidden();
}

for (const width of [1280, 390]) {
  test(`canvas editor generates, validates, subscribes and enhances all fields at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openEditor(page);
    await page.getByRole('textbox', { name: 'Intent', exact: true }).fill('Compare run conclusions');
    await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Workflow runs');
    await page.getByRole('textbox', { name: 'Acceptance criteria', exact: true }).fill('Show native conclusion counts');
    const improve = page.getByRole('button', { name: 'Improve all fields with Copilot', exact: true });
    await expect(improve).toBeVisible();
    const box = await improve.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await improve.click();
    for (const label of ['Intent', 'Subject', 'Objective (optional)', 'Acceptance criteria']) {
      await expect(page.getByRole('textbox', { name: label, exact: true })).toHaveValue(/^Enhanced /);
    }
    await page.getByRole('button', { name: 'Generate query and view', exact: true }).click();
    await expect(page.locator('.query-editor > [role=status]')).toContainText('Preview updated');
    const preview = page.locator('.query-editor-preview');
    await expect(preview.getByRole('heading', { name: 'Run conclusions', exact: true })).toBeVisible();
    await expect(preview.locator('svg').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Dashboard Language document', exact: true })).toBeHidden();
    await page.getByText('Dashboard Language source (advanced)', { exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Dashboard Language document', exact: true });
    const accepted = await draft.inputValue();
    await draft.fill('[broken');
    await page.getByRole('button', { name: 'Validate and render', exact: true }).click();
    await expect(page.locator('.query-editor-errors')).toBeVisible();
    await expect(preview.locator('svg').first()).toBeVisible();
    await draft.fill(accepted);
    await page.getByRole('button', { name: 'Validate and render', exact: true }).click();
    await expect(page.locator('.query-editor > [role=status]')).toContainText('Preview updated');
    await page.getByText('Dashboard Language source (advanced)', { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const screenshot = testInfo.outputPath(`query-editor-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`query-editor-${width}`, { path: screenshot, contentType: 'image/png' });
  });
}

test('saves a validated rendered view locally and restores it after reload', async ({ page }) => {
  await openEditor(page);
  const save = page.getByRole('button', { name: 'Save as custom view', exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole('textbox', { name: 'Intent', exact: true }).fill('Compare run conclusions');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Workflow runs');
  await page.getByRole('textbox', { name: 'Acceptance criteria', exact: true }).fill('Show native conclusion counts');
  await page.getByRole('button', { name: 'Generate query and view', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page).toHaveURL(/#page-local-[a-f0-9]{24}$/);
  const rendered = page.locator('.dashboard-page:not([hidden])');
  await expect(rendered.getByRole('heading', { name: 'Run conclusions', exact: true })).toBeVisible();
  await expect(rendered.locator('svg').first()).toBeVisible();
  await expect(page.locator('.query-editor')).toHaveCount(0);
  const id = new URL(page.url()).hash.slice('#page-'.length);
  const saved = JSON.parse(await readFile(join(workspace, '.cao/dashboard/custom-views', `${id}.json`), 'utf8'));
  expect(saved).toEqual(previewDocument);
  await page.reload();
  await expect(rendered.getByRole('heading', { name: 'Run conclusions', exact: true })).toBeVisible();
  await expect(rendered.locator('svg').first()).toBeVisible();
});

test('preview subscriptions refresh from canonical ingestion and worker output stays bounded', async ({ page, context }) => {
  await openEditor(page);
  await page.getByText('Dashboard Language source (advanced)', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Dashboard Language document', exact: true }).fill(JSON.stringify(previewDocument));
  await page.getByRole('button', { name: 'Validate and render', exact: true }).click();
  await expect(page.locator('.query-editor > [role=status]')).toContainText('Preview updated');
  await context.route('**/query-editor-update.json', (route) => route.fulfill({
    json: {
      ...sources,
      runs: {
        metadata: { 'as-of': '2026-10-10T11:00:00Z', 'artifact-generation': 'query-editor-refresh' },
        rows: Array.from({ length: 251 }, (_, index) => ({
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/example.md',
          run: String(1000 + index), 'run-attempt': 1, 'run-status': 'completed', 'run-conclusion': 'failure',
          'started-at': '2026-10-10T10:00:00Z'
        }))
      }
    }
  }));
  const outputCounts = await page.evaluate(async () => {
    const { refreshCanonicalDashboardSources, loadCanonicalDashboardPage, validateQueryEditorDocument } =
      await import(new URL('./src/data-processor.js', location.href).href);
    await refreshCanonicalDashboardSources(new URL('./query-editor-update.json', location.href).href, [], { pages: [] });
    const result = await validateQueryEditorDocument(JSON.stringify({
      'language-version': '0.1.0',
      dashboard: {
        id: 'bounded-runs', title: 'Bounded runs',
        queries: [{ name: 'bounded-runs', subject: 'Retained workflow run summaries', from: 'runs', limit: 200 }],
        pages: [{
          id: 'query-preview', kind: 'custom', title: 'Bounded runs',
          views: [{
            id: 'bounded', mark: 'table', data: { source: 'bounded-runs', limit: 200 },
            encoding: { columns: [{ field: 'run', type: 'nominal' }] }
          }]
        }]
      }
    }));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const tables = await loadCanonicalDashboardPage(result.sourceNames, {
      pages: result.document.dashboard.pages, queries: result.document.dashboard.queries
    }, undefined, { pageId: result.pageId, signal: new AbortController().signal });
    return Object.values(tables).map((source) => source.rows.length);
  });
  expect(outputCounts.length).toBeGreaterThan(0);
  expect(outputCounts.every((count) => count === 200)).toBe(true);
  await expect(page.locator('.query-editor-preview .chart-legend-pie')).toContainText('252');
});

test('intent improvement preserves edits during an in-flight request and cancels on navigation', async ({ page }) => {
  await openEditor(page);
  const intent = page.getByRole('textbox', { name: 'Intent', exact: true });
  await intent.fill('Original intent');
  /** @type {{ route?: import('@playwright/test').Route }} */
  const pending = {};
  const pendingRoute = () => pending.route;
  await page.route('**/__query_designer/enhance', (route) => { pending.route = route; });
  await page.getByRole('button', { name: 'Improve all fields with Copilot', exact: true }).click();
  await expect.poll(() => Boolean(pending.route)).toBe(true);
  await intent.fill('New intent');
  await pending.route?.fulfill({ json: { intent: 'Obsolete enhancement', subject: 'Runs', objective: 'Investigate', acceptance: 'Native conclusions' } });
  await expect(page.locator('.query-editor > [role=status]')).toContainText('not applied');
  await expect(intent).toHaveValue('New intent');
  delete pending.route;
  await page.getByRole('button', { name: 'Improve all fields with Copilot', exact: true }).click();
  await expect.poll(() => Boolean(pending.route)).toBe(true);
  await page.locator('.query-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.query-editor > [role=status]')).toContainText('cancelled');
  await expect(intent).toHaveValue('New intent');
  await pendingRoute()?.abort();
  const response = await page.request.get(`${server.url}/dashboard.json`);
  const dashboard = await response.json();
  const other = dashboard.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id !== 'query-editor');
  await page.evaluate((id) => { location.hash = `#page-${id}`; }, other.id);
  await expect(page.locator('.query-editor')).toHaveCount(0);
});
