import { createServer } from 'node:http';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const siteRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outputPath = resolve(
  process.env.SWIMLANE_PERFORMANCE_OUTPUT
    || `${siteRoot}/test-results/swimlane-performance.json`
);
const observationCount = Number(process.env.SWIMLANE_OBSERVATIONS || 100_000);
const maximumRenderMilliseconds = Number(process.env.SWIMLANE_RENDER_BUDGET_MS || 1_000);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8']
]);

async function serveFile(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body></body></html>');
    return;
  }
  const path = resolve(siteRoot, `.${decodeURIComponent(url.pathname)}`);
  if (path !== siteRoot && !path.startsWith(`${siteRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(path);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': contentTypes.get(extname(path)) || 'application/octet-stream'
    });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
}

async function main() {
  const server = createServer((request, response) => {
    void serveFile(request, response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve performance server port');

  let browser;
  try {
    const configuredChromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const bundledChromePath = chromium.executablePath();
    const chromePath = configuredChromePath || await access(bundledChromePath)
      .then(() => bundledChromePath)
      .catch(() => '/usr/bin/chromium');
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const result = await page.evaluate(async (count) => {
      const { executeDashboardQuery } = await import('/src/data/queries/declarative.js');
      const { renderChartWidget } = await import('/src/components/chart-elements.js');
      const start = Date.parse('2026-08-01T00:00:00Z');
      const conclusions = ['success', 'failure', 'skipped', 'cancelled', 'action-required'];
      const rows = Array.from({ length: count }, (_, index) => ({
        run: String(index),
        'started-at': new Date(start + index).toISOString(),
        'run-conclusion': conclusions[index % conclusions.length]
      }));
      const source = {
        source: 'runs',
        rows,
        metadata: {
          'source-id': 'runs',
          'source-kind': 'canonical',
          'as-of': '2026-08-02T00:00:00Z',
          'retrieved-at': '2026-08-02T00:00:00Z',
          completeness: 'complete',
          freshness: 'fresh',
          availability: 'available'
        }
      };
      performance.mark('swimlane-query-start');
      const queriedRows = executeDashboardQuery({
        name: 'runs-table',
        from: 'runs',
        select: [
          { field: 'run' },
          { field: 'started-at' },
          { field: 'run-conclusion' }
        ],
        'order-by': [{ field: 'started-at', direction: 'desc' }]
      }, { runs: source }).rows;
      performance.mark('swimlane-query-end');

      performance.mark('swimlane-points-start');
      const points = queriedRows.map((row) => ({
        x: row['started-at'],
        y: Number.NaN,
        category: row['run-conclusion'],
        color: row['run-conclusion'],
        source: row
      }));
      performance.mark('swimlane-points-end');

      performance.mark('swimlane-render-start');
      const chart = renderChartWidget('swimlane', points, [], null, 'Total', null, {
        start: new Date(start).toISOString(),
        end: new Date(start + count).toISOString()
      });
      document.body.append(chart);
      chart.getBoundingClientRect();
      performance.mark('swimlane-render-end');
      performance.measure('query', 'swimlane-query-start', 'swimlane-query-end');
      performance.measure('point-preparation', 'swimlane-points-start', 'swimlane-points-end');
      performance.measure('render', 'swimlane-render-start', 'swimlane-render-end');
      return {
        durations: Object.fromEntries(
          performance.getEntriesByType('measure').map((entry) => [entry.name, entry.duration])
        ),
        marks: chart.querySelectorAll('.swimlane-mark').length,
        representedObservations: [...chart.querySelectorAll('.swimlane-mark')]
          .reduce((total, mark) => total + Number(mark.getAttribute('data-swimlane-count')), 0)
      };
    }, observationCount);

    const profile = {
      generatedAt: new Date().toISOString(),
      observationCount,
      maximumRenderMilliseconds,
      ...result,
      bottleneck: Object.entries(result.durations)
        .sort((left, right) => right[1] - left[1])[0][0]
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`);
    console.log(JSON.stringify(profile, null, 2));

    if (result.representedObservations !== observationCount) {
      throw new Error(`Swimlane represented ${result.representedObservations} of ${observationCount} observations`);
    }
    if (result.marks > 600) {
      throw new Error(`Swimlane rendered ${result.marks} marks; expected at most 600`);
    }
    if (result.durations.render > maximumRenderMilliseconds) {
      throw new Error(`Swimlane rendering took ${result.durations.render.toFixed(1)}ms; budget is ${maximumRenderMilliseconds}ms`);
    }
  } finally {
    await browser?.close();
    await new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
