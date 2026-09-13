import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const siteRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outputRoot = resolve(
  process.env.DASHBOARD_STORAGE_PERFORMANCE_OUTPUT_DIR
    || join(siteRoot, 'test-results', 'storage-performance')
);
const profileName = process.env.DASHBOARD_STORAGE_PERFORMANCE_PROFILE || 'contract';
const profiles = {
  contract: {
    corpus: {
      repositories: 100_000,
      workflows: 100_000,
      runs: 200_000,
      jobs: 20_000,
      sessions: 10_000,
      events: 20_000
    },
    warmups: 5,
    iterations: 20,
    pageSize: 100
  },
  smoke: {
    corpus: {
      repositories: 100,
      workflows: 100,
      runs: 200,
      jobs: 50,
      sessions: 25,
      events: 50
    },
    warmups: 1,
    iterations: 2,
    pageSize: 10
  }
};
const budgets = {
  coldReplaceMs: 10_000,
  warmOpenP95Ms: 200,
  indexedQueryP95Ms: 200,
  routeProjectionP95Ms: 500,
  mainThreadLongTaskMs: 50
};
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json']
]);

async function serveFile(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': contentTypes.get('.html') });
    response.end('<!doctype html><title>Canonical storage performance contract</title>');
    return;
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const path = resolve(siteRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(`${siteRoot}${sep}`)) {
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
  if (!address || typeof address === 'string') throw new Error('Unable to resolve storage benchmark server port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** @param {number} value */
function milliseconds(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'unavailable';
}

/** @param {Record<string, unknown>} metrics @param {{ pageSize: number }} profile */
function contractFailures(metrics, profile) {
  const failures = metrics.timedOutPhase
    ? [`${metrics.timedOutPhase} exceeded its execution deadline`]
    : [];
  const checks = [
    ['cold canonical replacement', 'coldReplaceMs', budgets.coldReplaceMs],
    ['warm database open p95', 'warmOpenP95Ms', budgets.warmOpenP95Ms],
    ['warm indexed query p95', 'indexedQueryP95Ms', budgets.indexedQueryP95Ms],
    ['route projection p95', 'routeProjectionP95Ms', budgets.routeProjectionP95Ms],
    ['main-thread long task', 'mainThreadLongTaskMs', budgets.mainThreadLongTaskMs]
  ];
  for (const [name, key, budget] of checks) {
    if (metrics.timedOutPhase === name) continue;
    const value = metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (!metrics.timedOutPhase) failures.push(`${name} is unavailable`);
    }
    else if (value > budget) failures.push(`${name} ${milliseconds(value)} exceeds ${milliseconds(budget)}`);
  }
  if (Number(metrics.pageRows) > profile.pageSize) {
    failures.push(`route returned ${metrics.pageRows} rows, exceeding page size ${profile.pageSize}`);
  }
  return failures;
}

async function main() {
  const profile = profiles[profileName];
  if (!profile) throw new Error(`Unknown storage performance profile: ${profileName}`);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const { server, origin } = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  let measured;
  try {
    const page = await browser.newPage();
    const failedResponses = [];
    page.on('console', (message) => console.log(message.text()));
    page.on('response', (response) => {
      if (!response.ok()) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    measured = await page.evaluate(({ workerUrl, profile, budgets }) => new Promise((resolvePromise, reject) => {
      const longTasks = [];
      let settled = false;
      let phaseTimeout;
      const observer = typeof PerformanceObserver === 'function'
        ? new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration);
          })
        : null;
      try {
        observer?.observe({ type: 'longtask', buffered: true });
      } catch {
        observer?.disconnect();
      }
      const worker = new Worker(workerUrl, { type: 'module' });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(overallTimeout);
        window.clearTimeout(phaseTimeout);
        observer?.disconnect();
        worker.terminate();
        resolvePromise({
          ...result,
          mainThreadLongTaskMs: Math.max(0, ...longTasks)
        });
      };
      const overallTimeout = window.setTimeout(() => {
        finish({ timedOutPhase: 'storage contract', timedOutBudgetMs: 60_000 });
      }, 60_000);
      worker.onerror = (event) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(overallTimeout);
        window.clearTimeout(phaseTimeout);
        observer?.disconnect();
        worker.terminate();
        reject(new Error(`${event.message} (${event.filename}:${event.lineno}:${event.colno})`));
      };
      worker.onmessage = (event) => {
        if (event.data.progress) {
          const milliseconds = Number(event.data.progress.milliseconds);
          console.info(`[storage-contract] ${event.data.progress.phase}${Number.isFinite(milliseconds) ? ` ${milliseconds.toFixed(2)} ms` : ''}`);
          if (event.data.progress.phase === 'corpus-ready') {
            phaseTimeout = window.setTimeout(() => {
              finish({
                timedOutPhase: 'cold canonical replacement',
                timedOutBudgetMs: budgets.coldReplaceMs,
                coldReplaceMs: budgets.coldReplaceMs + 1
              });
            }, budgets.coldReplaceMs);
          } else if (event.data.progress.phase === 'canonical-replacement-complete') {
            window.clearTimeout(phaseTimeout);
          }
          return;
        }
        if (event.data.error) {
          settled = true;
          window.clearTimeout(overallTimeout);
          window.clearTimeout(phaseTimeout);
          observer?.disconnect();
          worker.terminate();
          reject(new Error(event.data.stack || event.data.error));
          return;
        }
        finish(event.data.result);
      };
      worker.postMessage(profile);
    }), {
      workerUrl: `${origin}/test/performance/canonical-storage-worker.mjs`,
      profile,
      budgets
    }).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${failedResponses.length > 0 ? `; failed responses: ${failedResponses.join(', ')}` : ''}`);
    });
  } finally {
    await browser.close();
    await new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  }

  const metrics = {
    coldReplaceMs: measured.coldReplaceMs,
    warmOpenP95Ms: measured.warmOpen?.p95Ms,
    indexedQueryP95Ms: measured.indexedQuery?.p95Ms,
    routeProjectionP95Ms: measured.routeProjection?.p95Ms,
    mainThreadLongTaskMs: measured.mainThreadLongTaskMs,
    pageRows: measured.pageRows,
    totalRows: measured.totalRows,
    timedOutPhase: measured.timedOutPhase,
    timedOutBudgetMs: measured.timedOutBudgetMs
  };
  const failures = contractFailures(metrics, profile);
  const summary = {
    contractVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: 'Chromium dedicated Web Worker with native IndexedDB; median and p95 exclude warmup iterations',
    profile: profileName,
    corpus: profile.corpus,
    samples: { warmups: profile.warmups, measured: profile.iterations },
    budgets,
    timedOutPhase: measured.timedOutPhase ?? null,
    timedOutBudgetMs: measured.timedOutBudgetMs ?? null,
    metrics,
    distributions: {
      warmOpen: measured.warmOpen,
      indexedQuery: measured.indexedQuery,
      routeProjection: measured.routeProjection
    },
    failures
  };
  await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`Canonical storage (${profileName}): replace ${milliseconds(metrics.coldReplaceMs)}, indexed query p95 ${milliseconds(metrics.indexedQueryP95Ms)}, route p95 ${milliseconds(metrics.routeProjectionP95Ms)}`);
  console.log(`Storage performance evidence: ${outputRoot}`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`::error title=Browser storage performance contract failed::${failure}`);
    return 42;
  }
  return 0;
}

try {
  const exitCode = await main();
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}