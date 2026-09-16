import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const buildScript = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url));
const controlSettings = fileURLToPath(new URL('../performance/fixtures/control-settings.json', import.meta.url));
const buildRoot = mkdtempSync(join(process.cwd(), '.lazy-page-chunks-'));
const origin = 'http://lazy-page-chunks.dashboard.test';

execFileSync(process.execPath, [buildScript, buildRoot, controlSettings], {
  cwd: siteRoot,
  stdio: 'inherit',
});

const inventory = {
  packages: {
    rows: [{
      package: 'dependabot',
      'package-name': 'Dependabot',
      'package-description': 'Dependabot automation',
      'package-icon': 'package',
      'package-mode': 'review',
      'package-enabled': true,
      'package-worker-count': 1,
      'package-min-version': 'v1.0.0',
      'observed-at': '2026-09-15T10:00:00Z',
    }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
  repositories: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
  workflows: {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      'workflow-name': 'Dashboard',
      role: 'orchestrator',
      state: 'active',
      updatedAt: '2026-09-15T10:00:00Z',
      ghAwMetadata: { strict: false },
      ghAwManifest: { actions: [] },
    }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
  'configuration-policy': {
    rows: [{
      path: '.github/workflows/cao.json',
      document: { version: 1, 'control-plane': { packages: {} } },
      raw: '{"version":1,"control-plane":{"packages":{}}}',
      diagnostics: [{
        severity: 'valid',
        path: '.github/workflows/cao.json',
        title: 'Policy is valid',
        detail: 'The runtime policy resolver accepted this revision.',
      }],
    }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
};

const logs = `${JSON.stringify({
  schema_version: 2,
  kind: 'run',
  run: {
    run_id: 1001,
    run_attempt: 1,
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow_name: 'Dashboard',
    workflow_path: '.github/workflows/dashboard.md',
    display_title: 'Dashboard run',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-15T10:00:00Z',
    updated_at: '2026-09-15T10:05:00Z',
  },
})}\n`;

test.afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/payload-hashes.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) }),
      });
      return;
    }
    if (pathname === '/inventory-sources.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(inventory) });
      return;
    }
    if (pathname === '/gh-aw-logs-shards/logs-1.jsonl') {
      await route.fulfill({ contentType: 'application/x-ndjson', body: logs });
      return;
    }
    let filePath = join(buildRoot, pathname);
    if (pathname === '/') filePath = join(buildRoot, 'index.html');
    else if (pathname.endsWith('/')) filePath = join(buildRoot, pathname, 'index.html');
    if (existsSync(filePath)) {
      const contentType = pathname.endsWith('.json')
        ? 'application/json'
        : pathname.endsWith('.svg')
          ? 'image/svg+xml'
          : pathname.endsWith('.webmanifest')
            ? 'application/manifest+json'
            : pathname.endsWith('.map')
              ? 'application/json'
              : pathname.endsWith('.html') || pathname.endsWith('/')
                ? 'text/html'
                : 'application/javascript';
      await route.fulfill({ contentType, body: readFileSync(filePath) });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });
});

/** @param {import('@playwright/test').Page} page */
function captureChunkRequests(page) {
  /** @type {string[]} */
  const requests = [];
  page.on('response', (/** @type {import('@playwright/test').Response} */ response) => {
    if (!response.url().startsWith(`${origin}/dashboard-pages/`)) return;
    requests.push(decodeURIComponent(response.url().split('/dashboard-pages/')[1].replace(/\.json(?:\?.*)?$/, '')));
  });
  return requests;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} pageId
 */
async function navigateToPage(page, pageId) {
  await page.evaluate((nextPageId) => {
    const link = document.querySelector(`[data-nav-page-id="${nextPageId}"]`);
    if (!(link instanceof HTMLAnchorElement)) throw new Error(`Missing navigation link for ${nextPageId}.`);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, pageId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} pageId
 */
async function pageText(page, pageId) {
  return (await page.locator(`[data-page-id="${pageId}"]`).textContent()) ?? '';
}

test('core dashboard stays small and page chunks load on demand with in-memory caching', async ({ page }) => {
  const chunkRequests = captureChunkRequests(page);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('dashboard-pages/')) {
        const requests = Reflect.get(window, '__dashboardChunkFetches') ?? [];
        requests.push({ url, cache: init?.cache });
        Reflect.set(window, '__dashboardChunkFetches', requests);
      }
      return nativeFetch(input, init);
    };
  });
  await page.goto(`${origin}/#page-repositories`);

  const core = await page.evaluate(async () => {
    const response = await fetch('./dashboard.json', { cache: 'no-store' });
    return {
      textLength: (await response.clone().text()).length,
      value: await response.json(),
    };
  });
  expect(core.textLength).toBeLessThan(75000);
  expect(core.value.dashboard.pages.some((/** @type {{ views?: unknown[] }} */ entry) => Array.isArray(entry.views))).toBe(false);
  expect(core.value.dashboard.pages.some((/** @type {{ definition?: { views?: unknown[] } }} */ entry) => Array.isArray(entry.definition?.views))).toBe(false);

  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect.poll(() => pageText(page, 'repositories')).toMatch(/Ingestion %|No repositories discovered\.|gh-aw-cao/);
  await expect.poll(() => chunkRequests.filter((id) => id === 'repositories').length).toBe(1);

  await navigateToPage(page, 'runs');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect.poll(() => pageText(page, 'runs')).toMatch(/Runs in the last week/);
  await expect.poll(() => pageText(page, 'runs')).toMatch(/No runs observed\.|1001|Runs/);
  await expect.poll(() => chunkRequests.filter((id) => id === 'runs').length).toBe(1);

  await navigateToPage(page, 'repositories');
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect.poll(() => chunkRequests.filter((id) => id === 'repositories').length).toBe(1);

  await navigateToPage(page, 'configuration');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('[data-page-id="configuration"] .configuration-view')).toBeVisible();
  await expect(page.locator('[data-page-id="configuration"]')).not.toContainText('Affected source: configuration-policy');
  await expect.poll(() => chunkRequests.filter((id) => id === 'configuration').length).toBe(1);
  const configurationFetch = await page.evaluate(() =>
    Reflect.get(window, '__dashboardChunkFetches')?.find(
      (/** @type {{ url: string }} */ request) => request.url.endsWith('/configuration.json')
    )
  );
  expect(configurationFetch?.cache).toBe('reload');
});

test('deep links and redirect routes fetch only the requested initial page chunk', async ({ page }) => {
  const hashChunkRequests = captureChunkRequests(page);
  await page.goto(`${origin}/#page-runs`);
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect.poll(() => pageText(page, 'runs')).toMatch(/Runs in the last week/);
  await expect.poll(() => [...new Set(hashChunkRequests)].sort()).toEqual(['runs']);

  const routeChunkRequests = captureChunkRequests(page);
  await page.goto(`${origin}/repositories/`);
  await expect(page).toHaveURL(`${origin}/#page-repositories`);
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect.poll(() => pageText(page, 'repositories')).toMatch(/Ingestion %|No repositories discovered\.|gh-aw-cao/);
  await expect.poll(() => [...new Set(routeChunkRequests)].sort()).toEqual(['repositories']);
});
