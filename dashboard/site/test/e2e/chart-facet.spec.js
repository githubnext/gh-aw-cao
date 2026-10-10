import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' });
      return;
    }
    const path = join(siteRoot, pathname);
    await route.fulfill(existsSync(path) ? {
      contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
      body: readFileSync(path)
    } : { status: 404, body: 'Not found' });
  });
  await page.goto('http://dashboard.test/');
});

test('worker-produced facets render as responsive accessible charts and refresh without grouping in the UI', async ({ page }) => {
  await page.evaluate(async () => {
    const { compileDashboardViewPayloadQueries } = await import(`${location.origin}/src/data/queries/view-payload-compiler.js`);
    const { renderDataView } = await import(`${location.origin}/src/components/data-view.js`);
    const { buildChartPoints, toViewText } = await import(`${location.origin}/src/components/view-data.js`);
    const { chartStyles } = await import(`${location.origin}/src/styles-charts.js`);
    const { effect, state } = await import(`${location.origin}/src/reactive.js`);
    const fixture = await fetch(`${location.origin}/test/fixtures/chart-facet-contract.json`).then((response) => response.json());
    const view = fixture.dashboard.pages[0].views[0];
    const compiled = compileDashboardViewPayloadQueries(fixture.dashboard.pages[0], 'facets');
    const worker = new Worker(`${location.origin}/src/data-worker.js`, { type: 'module' });
    const metadata = {
      'source-id': 'facet-evidence', 'source-kind': 'fixture', 'as-of': '2026-10-01T00:00:00Z',
      'retrieved-at': '2026-10-01T00:00:00Z', availability: 'available', completeness: 'complete', freshness: 'fresh'
    };
    const output = state(null);
    worker.onmessage = (event) => output.set(event.data.data?.[compiled.aliases[0]] ?? null);
    const style = document.createElement('style');
    style.textContent = chartStyles;
    document.head.append(style);
    const root = document.querySelector('#root');
    const controller = new AbortController();
    /** @param {Array<Record<string, unknown>>} rows */
    const send = (rows) => worker.postMessage({
      id: 1, operation: 'execute-dashboard-queries', queries: compiled.queries, sourceNames: compiled.aliases,
      sources: { usage: { source: 'usage', rows, metadata } }
    });

    effect(() => {
      const source = output.get();
      if (!source || !root) return;
      const query = () => { throw new Error('UI must not query data'); };
      const chart = renderDataView('chart', {
        pageId: 'facets', title: view.title, view, sourceName: source.source, rows: source.rows, metadata: source.metadata,
        contextDetails: [], headingTag: 'h2', buildChartPoints, toText: toViewText,
        prepareChartPoints: query, prepareTableRows: query
      });
      if (chart) root.replaceChildren(chart);
    }, { signal: controller.signal });
    send([
      { engine: 'copilot', workflow: 'worker', aic: 2 },
      { engine: 'claude', workflow: 'worker', aic: 9 },
      { engine: 'copilot', workflow: 'worker', aic: 3 }
    ]);
    const refresh = document.createElement('button');
    refresh.textContent = 'Refresh evidence';
    refresh.onclick = () => send([
      { engine: 'copilot', workflow: 'worker', aic: 12 },
      { engine: 'claude', workflow: 'worker', aic: 15 },
      { engine: 'codex', workflow: 'worker', aic: 7 }
    ]);
    const dispose = document.createElement('button');
    dispose.textContent = 'Dispose facets';
    dispose.onclick = () => { controller.abort(); worker.terminate(); root?.replaceChildren(); };
    document.body.append(refresh, dispose);
  });
  const figures = page.getByRole('figure');
  await expect(figures).toHaveCount(2);
  await expect(page.getByRole('figure', { name: 'Engine: copilot' })).toBeVisible();
  await expect(page.getByRole('img', { name: /worker: 5/ })).toBeVisible();
  const desktop = await figures.evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().top));
  expect(desktop[0]).toBe(desktop[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await figures.evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().top));
  expect(mobile[1]).toBeGreaterThan(mobile[0]);
  await page.getByRole('button', { name: 'Refresh evidence' }).click();
  await expect(figures).toHaveCount(3);
  await expect(page.getByRole('figure', { name: 'Engine: codex' })).toBeVisible();
  await expect(page.getByRole('img', { name: /worker: 12/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Dispose facets' }).click();
  await expect(figures).toHaveCount(0);
});

test('canonical view subscriptions republish faceted charts after evidence refresh', async ({ page }) => {
  const view = {
    id: 'canonical-facets', title: 'Runs by engine', mark: 'chart', chart: 'bar', columns: 2,
    facet: { field: 'engine', title: 'Engine' }, data: { source: 'runs' },
    encoding: {
      x: { field: 'workflow', type: 'nominal' },
      y: { field: 'run', type: 'quantitative', aggregate: 'count' }
    }
  };
  const model = { languageVersion: '0.1.0', dashboard: {
    id: 'facet-subscriptions', title: 'Facet subscriptions',
    pages: [{ id: 'facets', kind: 'custom', title: 'Facets', views: [view] }]
  } };
  let updated = false;
  await page.route('http://dashboard.test/sources.json', async (route) => {
    const now = new Date().toISOString();
    const metadata = { 'as-of': now, 'artifact-generation': updated ? 'updated' : 'initial' };
    const identity = { organization: 'octo', repository: 'repo', workflow: '.github/workflows/worker.md' };
    const rows = [
      { ...identity, run: '1', engine: 'copilot' },
      { ...identity, run: '2', engine: 'claude' },
      { ...identity, run: '3', engine: 'copilot' },
      ...(updated ? [{ ...identity, run: '4', engine: 'codex' }] : [])
    ].map((row) => ({ ...row, 'run-attempt': 1, 'run-status': 'completed', 'run-conclusion': 'success', 'started-at': now }));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      repositories: { rows: [{ organization: 'octo', repository: 'repo' }], metadata },
      workflows: { rows: [identity], metadata }, runs: { rows, metadata }
    }) });
  });
  await page.evaluate(async (documentModel) => {
    const { renderDashboard, dashboardPageSourceNames } = await import(`${location.origin}/src/presenter.js`);
    const { loadCanonicalDashboardSources, subscribeCanonicalDashboardView } = await import(`${location.origin}/src/data-processor.js`);
    const { chartStyles } = await import(`${location.origin}/src/styles-charts.js`);
    const style = document.createElement('style');
    style.textContent = chartStyles;
    document.head.append(style);
    const dashboardContext = { pages: documentModel.dashboard.pages, githubUrlBase: 'https://github.com' };
    await loadCanonicalDashboardSources(`${location.origin}/sources.json`, [], dashboardContext);
    /** @type {import('../../src/presenter.js').PageSourceLoader} */
    const loader = (pageId, options) => new Promise((resolve, reject) => {
      let initial = true;
      subscribeCanonicalDashboardView('facet-subscriptions',
        dashboardPageSourceNames(documentModel, pageId, options.queryContext?.viewMode),
        dashboardContext, (/** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ result) => {
          if (initial) { initial = false; resolve(result); }
          else options.onUpdate(result);
        }, undefined, { ...options, pageId, onError: reject });
    });
    location.hash = '#page-facets';
    const root = renderDashboard({ document: documentModel, sources: {}, loadPageSources: loader });
    document.querySelector('#root')?.replaceChildren(root);
  }, model);
  const figures = page.locator('[data-view-id="canonical-facets"] figure');
  await expect(figures).toHaveCount(2);
  await expect(page.getByRole('figure', { name: 'Engine: copilot' }).locator('svg [aria-label*=": 2"]')).toBeVisible();
  updated = true;
  await page.evaluate(async (documentModel) => {
    const { refreshCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
    await refreshCanonicalDashboardSources(`${location.origin}/sources.json`, [], {
      pages: documentModel.dashboard.pages, githubUrlBase: 'https://github.com'
    });
  }, model);
  await expect(figures).toHaveCount(3);
  await expect(page.getByRole('figure', { name: 'Engine: codex' })).toBeVisible();
});
