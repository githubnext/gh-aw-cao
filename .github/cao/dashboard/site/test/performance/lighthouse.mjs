import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const sourceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const siteRoot = resolve(process.env.DASHBOARD_PERFORMANCE_SITE_ROOT || join(sourceRoot, 'dist'));
const lighthouseCli = join(sourceRoot, 'node_modules', 'lighthouse', 'cli', 'index.js');
const outputRoot = resolve(
  process.env.DASHBOARD_PERFORMANCE_OUTPUT_DIR
    || join(sourceRoot, 'test-results', 'lighthouse')
);

// Allows small run-to-run variance while retaining a high Lighthouse score.
const scoreThreshold = 0.88;
const metricBudgets = {
  'cumulative-layout-shift': 0.1,
  'first-contentful-paint': 1800,
  'largest-contentful-paint': 2500,
  'speed-index': 3400,
  'total-blocking-time': 200
};

const scenarios = [
  {
    id: 'cfo',
    persona: 'Chief Financial Officer',
    question: 'Where is AI Credit usage concentrated, and is it producing operational value?',
    routes: ['cost', 'usage', 'packages']
  },
  {
    id: 'cto',
    persona: 'Chief Technology Officer',
    question: 'Which automation bottleneck most threatens control-plane reliability?',
    routes: ['readiness', 'performance', 'workflows']
  },
  {
    id: 'cso',
    persona: 'Chief Security Officer',
    question: 'Which assurance gap requires immediate action?',
    routes: ['security', 'findings', 'readiness']
  }
];

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function serveFile(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const path = resolve(siteRoot, `.${pathname}`);
  if (path !== siteRoot && !path.startsWith(`${siteRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }

  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': contentTypes.get(extname(path)) || 'application/octet-stream'
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
}

async function startServer() {
  const server = createServer((request, response) => {
    void serveFile(request, response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve dashboard server port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function routeUrl(origin, route) {
  return `${origin}/?fixtures=1#page-${route}`;
}

async function recordJourney(browser, origin, scenario, directory) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(routeUrl(origin, scenario.routes[0]), { waitUntil: 'networkidle' });
    for (const route of scenario.routes) {
      if (route !== scenario.routes[0]) {
        await page.evaluate((pageId) => {
          window.location.hash = `#page-${pageId}`;
        }, route);
      }
      await page.locator(`[data-page-id="${route}"]`).waitFor({ state: 'visible' });
    }
    if (errors.length > 0) throw new Error(`${scenario.id} journey page errors: ${errors.join('; ')}`);
  } finally {
    await context.tracing.stop({ path: join(directory, 'playwright-trace.zip') });
    await context.close();
  }
}

async function auditOverviewIngestion(browser, origin, _directory) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  let ingestionStartedAt = 0;
  let ingestionCompletedAt = 0;
  let markIngestionStarted;
  const ingestionStarted = new Promise((resolvePromise) => {
    markIngestionStarted = resolvePromise;
  });
  await page.route('**/inventory-sources.json', async (route) => {
    ingestionStartedAt = performance.now();
    markIngestionStarted();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    ingestionCompletedAt = performance.now();
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });

  const startedAt = performance.now();
  const navigation = page.goto(`${origin}/#page-overview`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('[data-page-id="overview"] .agent-factory').waitFor({
      state: 'visible',
      timeout: 2000
    });
    await page.locator('.factory-station:not(.factory-station-pending)').first().waitFor({
      state: 'visible',
      timeout: 2000
    });
    await Promise.race([
      ingestionStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Dashboard ingestion did not start after page configuration.')),
        2000
      ))
    ]);
    const overviewInteractiveMs = performance.now() - startedAt;
    if (await page.locator('.dashboard-loading-skeleton').count() > 0) {
      throw new Error('Overview retained its page skeleton during ingestion.');
    }
    if (ingestionStartedAt === 0 || ingestionCompletedAt !== 0) {
      throw new Error('Overview did not become interactive while ingestion was pending.');
    }
    return {
      status: 'complete',
      overviewInteractiveMs,
      budgetMs: 2000,
      ingestionPending: true
    };
  } finally {
    await navigation;
    await context.close();
  }
}

function auditValue(lhr, auditId) {
  const value = lhr.audits?.[auditId]?.numericValue;
  if (typeof value !== 'number') throw new Error(`Lighthouse report omitted ${auditId}`);
  return value;
}

async function auditScenario(origin, scenario, directory, chromePath) {
  const reportPath = join(directory, 'lighthouse');
  await run(process.execPath, [
    lighthouseCli,
    routeUrl(origin, scenario.routes[0]),
    '--quiet',
    '--preset=desktop',
    '--only-categories=performance',
    '--output=json',
    '--output=html',
    `--output-path=${reportPath}`,
    '--save-assets',
    '--disable-full-page-screenshot',
    '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage'
  ], {
    env: { ...process.env, CHROME_PATH: chromePath }
  });

  const lhr = JSON.parse(await readFile(`${reportPath}.report.json`, 'utf8'));
  const score = lhr.categories?.performance?.score;
  if (typeof score !== 'number') throw new Error(`${scenario.id} Lighthouse report omitted its performance score`);

  const metrics = Object.fromEntries(
    Object.keys(metricBudgets).map((auditId) => [auditId, auditValue(lhr, auditId)])
  );
  const failures = [];
  if (score < scoreThreshold) failures.push(`score ${score.toFixed(2)} is below ${scoreThreshold.toFixed(2)}`);
  for (const [auditId, budget] of Object.entries(metricBudgets)) {
    if (metrics[auditId] > budget) {
      failures.push(`${auditId} ${metrics[auditId].toFixed(2)} exceeds ${budget}`);
    }
  }

  return {
    id: scenario.id,
    persona: scenario.persona,
    question: scenario.question,
    routes: scenario.routes,
    score,
    aspirationalScore: 1,
    passingScore: scoreThreshold,
    metrics,
    budgets: metricBudgets,
    failures
  };
}

async function main() {
  await access(lighthouseCli);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });

  const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  await access(chromePath);
  const { server, origin } = await startServer();
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const results = [];
  let overviewIngestion;

  try {
    const overviewDirectory = join(outputRoot, 'overview-ingestion');
    await mkdir(overviewDirectory, { recursive: true });
    overviewIngestion = await auditOverviewIngestion(browser, origin, overviewDirectory);
    for (const scenario of scenarios) {
      const directory = join(outputRoot, scenario.id);
      await mkdir(directory, { recursive: true });
      await recordJourney(browser, origin, scenario, directory);
      results.push(await auditScenario(origin, scenario, directory, chromePath));
    }
  } finally {
    await browser.close();
    await new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    methodology: 'Lighthouse desktop cold navigation plus Playwright traced persona journey',
    overviewIngestion,
    results
  };
  await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const failures = results.flatMap((result) =>
    result.failures.map((failure) => `${result.id}: ${failure}`)
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`::warning title=Lighthouse budget exceeded::${failure}`);
    }
    console.warn(`Dashboard performance budgets exceeded:\n${failures.join('\n')}`);
  }

  for (const result of results) {
    console.log(`${result.id}: Lighthouse performance ${(result.score * 100).toFixed(0)}`);
  }
  console.log(`overview: interactive during ingestion in ${overviewIngestion.overviewInteractiveMs.toFixed(0)}ms`);
  console.log(`Performance evidence: ${outputRoot}`);
  return failures.length > 0 ? 42 : 0;
}

try {
  const exitCode = await main();
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
