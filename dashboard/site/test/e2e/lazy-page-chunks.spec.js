import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedRunShard } from './normalized-shard.js';
import { expect, test } from '@playwright/test';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const buildScript = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url));
const controlSettings = fileURLToPath(new URL('../performance/fixtures/control-settings.json', import.meta.url));
/** @type {string} */
let buildRoot;
const origin = 'http://lazy-page-chunks.dashboard.test';
const shardName = `gh-aw-logs-runs/logs-${'a'.repeat(64)}-${'b'.repeat(16)}.jsonl`;

test.beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), 'lazy-page-chunks-'));
  execFileSync(process.execPath, [buildScript, buildRoot, controlSettings], {
    cwd: siteRoot,
    stdio: 'inherit',
  });
});

const inventory = {
  campaigns: {
    rows: [{
      campaign: 'dependabot',
      'campaign-name': 'Dependabot',
      'campaign-description': 'Dependabot automation',
      'campaign-icon': 'goal',
      'campaign-mode': 'review',
      'campaign-enabled': true,
      'campaign-worker-count': 1,
      'campaign-min-version': 'v1.0.0',
      'observed-at': '2026-09-15T10:00:00Z',
    }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
  repositories: {
    rows: [{ id: 'repository:githubnext/gh-aw-cao', organization: 'githubnext', repository: 'gh-aw-cao' }],
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
  'marketplace-packages': {
    rows: [{
      id: `official:githubnext/gh-aw-cao/dependabot@${'a'.repeat(40)}`,
      'registry-id': 'official',
      'registry-name': 'Official CAO catalog',
      'registry-precedence': 0,
      name: 'Dependabot',
      description: 'Dependabot automation',
      publisher: 'githubnext',
      repository: 'githubnext/gh-aw-cao',
      'repository-link': {
        relation: 'repository',
        href: 'https://github.com/githubnext/gh-aw-cao',
        label: 'Open githubnext/gh-aw-cao on GitHub',
      },
      path: 'dependabot',
      ref: 'main',
      'resolved-commit': 'a'.repeat(40),
      version: 'main',
      icon: 'workflow',
      artwork: '',
      contents: ['aw.yml'],
      readme: '# Dependabot\n\nKeeps dependency updates moving.\n',
      'readme-path': 'dependabot/README.md',
      source: `githubnext/gh-aw-cao/dependabot@${'a'.repeat(40)}`,
      'add-command': `./cao.sh add githubnext/gh-aw-cao/dependabot@${'a'.repeat(40)}`,
    }, ...['aw-optimization', 'cao-evolution'].map((path, index) => ({
      id: `official:githubnext/gh-aw-cao/${path}@${'b'.repeat(40)}`,
      'registry-id': 'official',
      'registry-name': 'Official CAO catalog',
      'registry-precedence': 0,
      name: index === 0 ? 'AW Optimization' : 'CAO Evolution',
      description: `${path} automation`,
      publisher: 'githubnext',
      repository: 'githubnext/gh-aw-cao',
      path,
      ref: 'main',
      'resolved-commit': 'b'.repeat(40),
      version: 'main',
      icon: 'workflow',
      artwork: '',
      contents: ['aw.yml'],
      readme: `# ${path}\n`,
      'readme-path': `${path}/README.md`,
      source: `githubnext/gh-aw-cao/${path}@${'b'.repeat(40)}`,
      'add-command': `./cao.sh add githubnext/gh-aw-cao/${path}@${'b'.repeat(40)}`,
      'observed-at': '2026-09-15T10:00:00Z',
    })), {
      id: `official:githubnext/gh-aw-cao/aw-optimization@${'c'.repeat(40)}`,
      'registry-id': 'official',
      'registry-name': 'Official CAO catalog',
      'registry-precedence': 0,
      name: 'AW Optimization',
      description: 'Earlier package revision',
      publisher: 'githubnext',
      repository: 'githubnext/gh-aw-cao',
      path: 'aw-optimization',
      ref: 'main',
      'resolved-commit': 'c'.repeat(40),
      version: 'main',
      icon: 'workflow',
      artwork: '',
      contents: ['aw.yml'],
      readme: '# aw-optimization\n',
      'readme-path': 'aw-optimization/README.md',
      source: `githubnext/gh-aw-cao/aw-optimization@${'c'.repeat(40)}`,
      'add-command': `./cao.sh add githubnext/gh-aw-cao/aw-optimization@${'c'.repeat(40)}`,
      'observed-at': '2026-09-14T10:00:00Z',
    }],
    metadata: { 'as-of': '2026-09-15T10:00:00Z', 'retrieved-at': '2026-09-15T10:00:00Z', completeness: 'complete', freshness: 'fresh', availability: 'available' },
  },
  'configuration-policy': {
    rows: [{
      path: '.github/workflows/cao.json',
      document: { version: 1, 'control-plane': { campaigns: {} } },
      raw: '{"version":1,"control-plane":{"campaigns":{}}}',
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
        body: JSON.stringify({ [shardName]: 'a'.repeat(64) }),
      });
      return;
    }
    if (pathname === '/inventory-sources.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(inventory) });
      return;
    }
    if (pathname === `/${shardName}`) {
      await route.fulfill({ contentType: 'application/x-ndjson', body: normalizedRunShard(logs) });
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
  expect(core.textLength).toBeLessThan(76000);
  expect(core.value.dashboard.pages.some((/** @type {{ views?: unknown[] }} */ entry) => Array.isArray(entry.views))).toBe(false);
  expect(core.value.dashboard.pages.some((/** @type {{ definition?: { views?: unknown[] } }} */ entry) => Array.isArray(entry.definition?.views))).toBe(false);

  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => pageText(page, 'repositories')).toMatch(/Top repositories with issues/);
  await page.getByRole('button', { name: 'Table' }).click();
  await expect.poll(() => pageText(page, 'repositories')).toMatch(
    /Ingestion %|No repositories discovered\.|gh-aw-cao|Loading Repositories/
  );
  await expect.poll(() => chunkRequests.filter((id) => id === 'repositories').length).toBe(1);

  await navigateToPage(page, 'runs');
  await expect(page.getByRole('heading', { name: 'Runs', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => pageText(page, 'runs')).toMatch(/Runs in the last week/);
  await expect.poll(() => pageText(page, 'runs')).toMatch(/No runs observed\.|1001|Runs/);
  await expect.poll(() => chunkRequests.filter((id) => id === 'runs').length).toBe(1);

  await navigateToPage(page, 'repositories');
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => chunkRequests.filter((id) => id === 'repositories').length).toBe(1);

  await navigateToPage(page, 'configuration');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
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

test('async Factory Overview elements receive their chunked query definitions', async ({ page }) => {
  const chunkRequests = captureChunkRequests(page);
  await page.goto(`${origin}/#page-overview`);

  const overview = page.locator('[data-page-id="overview"]');
  await expect(overview).not.toContainText('No custom views available.');
  await expect(overview.locator(':scope > .custom-view-grid > .custom-view')).toHaveCount(3);
  await expect(overview.getByRole('heading', { name: 'Your campaigns are humming.' })).toBeVisible();
  await expect(overview.locator('.factory-station').nth(0)).toContainText('1');
  await expect(overview.locator('.factory-station').nth(1)).toContainText('1');
  await expect(overview).not.toContainText('Unavailable');
  await expect.poll(() => chunkRequests.filter((id) => id === 'overview').length).toBe(1);
});

test('marketplace page renders canonical package cards after ingestion', async ({ page }) => {
  await page.goto(`${origin}/#page-marketplace`);

  const marketplace = page.locator('[data-page-id="marketplace"]');
  await expect(page.getByRole('heading', { name: 'Marketplace', exact: true, level: 1 })).toBeVisible();
  const packageCards = marketplace.locator('.entity-card-list-marketplace .entity-card-list-card');
  await expect(packageCards).toHaveCount(3);
  await expect(packageCards.locator('.issue-list-card-title')).toHaveText([
    'AW Optimization',
    'CAO Evolution',
    'Dependabot'
  ]);
  const packageCard = packageCards.filter({ hasText: 'Dependabot' });
  await expect(marketplace.locator('.entity-card-list-marketplace')).toHaveCSS('display', 'grid');
  await expect.poll(async () => {
    const cardBoxes = await packageCards.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().toJSON()));
    return cardBoxes.length === 3
      && cardBoxes[1].y === cardBoxes[0].y
      && cardBoxes[1].x >= cardBoxes[0].x + cardBoxes[0].width + 12;
  }).toBe(true);
  await expect(marketplace).toContainText('Dependabot');
  await expect(packageCard).toContainText('By');
  await expect(packageCard).toContainText('githubnext');
  await expect(packageCards.filter({ hasText: 'Earlier package revision' })).toHaveCount(0);
  await expect(packageCard.getByRole('button', { name: 'Add' })).toHaveCount(0);
  await expect(marketplace).not.toContainText('Unable to load this page.');

  await expect(marketplace.locator('.marketplace-controls')).toHaveCount(0);
  await expect(marketplace.getByRole('searchbox')).toHaveCount(0);
  await expect(packageCards).toHaveCount(3);

  for (let navigation = 0; navigation < 3; navigation += 1) {
    await navigateToPage(page, 'repositories');
    await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 1 })).toBeVisible();
    await navigateToPage(page, 'marketplace');
    await expect(page.getByRole('heading', { name: 'Marketplace', exact: true, level: 1 })).toBeVisible();
    await expect(packageCards).toHaveCount(3);
    await expect(packageCards.locator('.issue-list-card-title')).toHaveText([
      'AW Optimization',
      'CAO Evolution',
      'Dependabot'
    ]);
  }

  await packageCard.getByRole('link', { name: 'Dependabot' }).click();
  const detail = page.locator('[data-page-id="marketplace-package"]');
  await expect(detail).toBeVisible();
  await expect(page.locator('#page-title')).toHaveText('Dependabot');
  const add = detail.locator('.entity-card-list-actions .cli-action-trigger');
  await expect(add).toBeVisible();
  await expect(add).toHaveAccessibleName('Add');
  await expect(add.locator(':scope > .octicon')).toHaveCSS('color', 'rgb(255, 255, 255)');
  const dashboardRoot = page.locator('.dashboard-root');
  await dashboardRoot.evaluate((root) => root.setAttribute('data-theme', 'dark'));
  await expect(add).toHaveCSS('color', 'rgb(13, 17, 23)');
  await expect(add.locator(':scope > .octicon')).toHaveCSS('color', 'rgb(13, 17, 23)');
  await dashboardRoot.evaluate((root) => root.setAttribute('data-theme', 'light'));
  await add.click();
  await expect(page.locator('.cli-action-dialog .cli-action-command')).toHaveText(
    `bash ./cao.sh add githubnext/gh-aw-cao/dependabot@${'a'.repeat(40)}`
  );
  await page.locator('.cli-action-dialog .cli-action-cancel').click();
  await expect(detail.locator('.dashboard-markdown')).toContainText('Keeps dependency updates moving.');
  const about = detail.locator('.link-button-list-view');
  await expect(about.getByRole('heading', { name: 'About' })).toBeVisible();
  const repositoryLink = about.getByRole('link', { name: 'Open githubnext/gh-aw-cao on GitHub' });
  await expect(repositoryLink).toHaveAttribute('href', 'https://github.com/githubnext/gh-aw-cao');
  await expect(about.locator('.link-button-list')).toHaveCSS('border-width', '0px');
  const readmeBox = await detail.locator('.dashboard-markdown').boundingBox();
  const aboutBox = await about.boundingBox();
  expect(aboutBox?.x ?? 0).toBeGreaterThan((readmeBox?.x ?? 0) + (readmeBox?.width ?? 0));
});

test('package detail failure offers recovery without rendering unrelated sections', async ({ page }) => {
  await page.goto(`${origin}/#page-marketplace-package?package-source=missing-package`);
  const detail = page.locator('[data-page-id="marketplace-package"]');
  await expect(detail.getByRole('heading', { name: 'Package unavailable' })).toBeVisible();
  await expect(detail).toContainText('It may have been removed');
  await expect(detail).not.toContainText('marketplace-package-detail');
  await expect(detail.getByRole('heading', { name: 'README' })).toBeHidden();
  await expect(detail.getByRole('heading', { name: 'About' })).toBeHidden();
  await expect(detail.getByRole('button', { name: 'Retry' })).toBeVisible();
  await detail.getByRole('button', { name: 'Retry' }).click();
  await expect(detail.getByRole('heading', { name: 'Package unavailable' })).toBeVisible();
  await detail.getByRole('link', { name: 'Back to Marketplace' }).click();
  await expect(page.locator('[data-page-id="marketplace"] .entity-card-list-card')).toHaveCount(3);
});

test('a partially loaded package keeps its metadata and identifies incomplete data', async ({ context, page }) => {
  await context.route(`${origin}/inventory-sources.json`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ...inventory,
      'marketplace-packages': {
        ...inventory['marketplace-packages'],
        metadata: { ...inventory['marketplace-packages'].metadata, completeness: 'partial' }
      }
    })
  }));
  await page.goto(`${origin}/#page-marketplace`);
  await page.locator('[data-page-id="marketplace"] .entity-card-list-card')
    .filter({ hasText: 'Dependabot' }).getByRole('link', { name: 'Dependabot' }).click();
  const detail = page.locator('[data-page-id="marketplace-package"]');
  await expect(detail).toContainText('Some package information could not be retrieved');
  await expect(detail.locator('.entity-card-list-card')).toHaveCount(1);
  await expect(detail.getByRole('heading', { name: 'Package unavailable' })).toBeHidden();
});

test('Marketplace is restored immediately after viewing a package without reloading the document', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  /** @type {string[]} */
  const documentLoads = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) documentLoads.push(request.url());
  });
  await page.goto(`${origin}/#page-marketplace`);
  const marketplace = page.locator('[data-page-id="marketplace"]');
  await expect(marketplace.locator('.entity-card-list-card')).toHaveCount(3);
  const scrollBefore = await page.locator('main.dashboard-prototype').evaluate((main) => {
    main.scrollTop = 120;
    return main.scrollTop;
  });
  const card = marketplace.locator('.entity-card-list-card').filter({ hasText: 'AW Optimization' });
  await card.getByRole('link', { name: 'AW Optimization' }).click();
  await expect(page.locator('[data-page-id="marketplace-package"] .entity-card-list-card')).toHaveCount(1);
  await page.goBack();
  await expect(marketplace.locator('.entity-card-list-card')).toHaveCount(3);
  await expect.poll(() => page.locator('main.dashboard-prototype').evaluate((main) => main.scrollTop)).toBe(scrollBefore);
  expect(documentLoads).toHaveLength(1);
});

test('deep links and redirect routes fetch only the requested initial page chunk', async ({ page }) => {
  const hashChunkRequests = captureChunkRequests(page);
  await page.goto(`${origin}/#page-runs`);
  await expect(page.getByRole('heading', { name: 'Runs', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => pageText(page, 'runs')).toMatch(/Runs in the last week/);
  await expect.poll(() => [...new Set(hashChunkRequests)].sort()).toEqual(['runs']);

  const routeChunkRequests = captureChunkRequests(page);
  await page.goto(`${origin}/repositories/`);
  await expect(page).toHaveURL(`${origin}/#page-repositories`);
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => pageText(page, 'repositories')).toMatch(/Top repositories with issues/);
  await expect.poll(() => [...new Set(routeChunkRequests)].sort()).toEqual(['repositories']);
});

test('Settings remains useful when its delayed policy source is unavailable', async ({ context, page }) => {
  const inventoryWithoutPolicy = Object.fromEntries(
    Object.entries(inventory).filter(([name]) => name !== 'configuration-policy')
  );
  await context.route(`${origin}/inventory-sources.json`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(inventoryWithoutPolicy),
  }));

  await page.goto(`${origin}/#page-configuration`);

  await expect(page.locator('[data-page-id="configuration"] .configuration-view')).toBeVisible();
  await expect(page.locator('[data-page-id="configuration"]')).toContainText(
    'The policy cannot be edited until it contains valid JSON.'
  );
  await expect(page.locator('[data-page-id="configuration"]')).not.toContainText(
    'Affected source: configuration-policy'
  );
});
