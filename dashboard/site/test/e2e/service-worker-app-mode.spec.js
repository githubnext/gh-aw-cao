import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

const shell = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8')
  .replace('const APP_ASSETS = [];', "const APP_ASSETS = ['./', 'src/main.js', 'src/data-worker.js'];");

/** @type {import('node:http').Server} */
let server;
let origin = '';
let offline = false;

test.beforeEach(async () => {
  offline = false;
  server = createServer((request, response) => {
    if (offline) {
      request.destroy();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/service-worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(worker);
    } else if (path === '/src/main.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('document.getElementById("root").textContent = "Dashboard script loaded";');
    } else if (path === '/src/data-worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('self.postMessage("Data worker loaded");');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(shell);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
});

/** @param {import('@playwright/test').Page} page */
async function registerWorker(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
}

/** @param {import('@playwright/test').Page} page */
async function cachedScripts(page) {
  return page.evaluate(async () => {
    const cache = await caches.open('central-agentic-ops-dashboard-app-development');
    return (await cache.keys()).map((request) => new URL(request.url).pathname).filter((path) => path.endsWith('.js'));
  });
}

test('regular tabs never cache scripts or fall back to an installed app script cache', async ({ page }) => {
  await page.goto(origin);
  await registerWorker(page);
  expect(await cachedScripts(page)).toEqual([]);
  await page.evaluate(async () => {
    navigator.serviceWorker.controller?.postMessage({
      type: 'CACHE_APP_ASSETS',
      urls: [new URL('/src/main.js', location.href).href]
    });
    await fetch('/src/main.js');
  });
  expect(await cachedScripts(page)).toEqual([]);
  await page.evaluate(async () => {
    const cache = await caches.open('central-agentic-ops-dashboard-app-development');
    await cache.put('/src/main.js', new Response('stale installed script'));
  });
  offline = true;
  expect(await page.evaluate(async () => {
    try {
      await fetch('/src/main.js');
      return 'cached';
    } catch {
      return 'network unavailable';
    }
  })).toBe('network unavailable');
});

for (const mode of ['standalone', 'minimal-ui', 'ios']) {
  test(`${mode} app caches JavaScript and bootstraps offline before the dashboard module loads`, async ({ page, context, browserName }) => {
    await page.addInitScript((mode) => {
      if (mode === 'ios') {
        Object.defineProperty(navigator, 'standalone', { value: true });
      } else {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const result = original(query);
          if (query.includes(`(display-mode: ${mode})`)) {
            Object.defineProperty(result, 'matches', { value: true });
          }
          return result;
        };
      }
    }, mode);
    await page.goto(origin);
    await registerWorker(page);
    expect(await cachedScripts(page)).toEqual(['/src/main.js', '/src/data-worker.js']);
    offline = true;
    if (browserName === 'chromium') {
      const session = await context.newCDPSession(page);
      await session.send('ServiceWorker.enable');
      await session.send('ServiceWorker.stopAllWorkers');
      await session.detach();
    }
    await page.reload();
    await expect(page.locator('#root')).toHaveText('Dashboard script loaded');
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/src/data-worker.js', { type: 'module' });
      worker.onmessage = (event) => { worker.terminate(); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); reject(new Error('Data worker did not load offline.')); };
    }));
    expect(result).toBe('Data worker loaded');
  });
}

test('opening an installed app after a browser visit caches the missing bundled scripts only for the app', async ({ page, context }) => {
  await page.goto(origin);
  await registerWorker(page);
  expect(await cachedScripts(page)).toEqual([]);
  const app = await context.newPage();
  await app.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  });
  await app.goto(origin);
  await app.evaluate(() => navigator.serviceWorker.controller?.postMessage({
    type: 'CACHE_APP_ASSETS',
    urls: [location.href]
  }));
  await expect.poll(() => cachedScripts(app)).toEqual(['/src/main.js', '/src/data-worker.js']);
  offline = true;
  expect(await page.evaluate(async () => {
    try {
      await fetch('/src/main.js');
      return 'cached';
    } catch {
      return 'network unavailable';
    }
  })).toBe('network unavailable');
  await app.reload();
  await expect(app.locator('#root')).toHaveText('Dashboard script loaded');
});
