import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

const shell = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const brokenWorker = `
  self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    if (event.request.mode === 'navigate') {
      event.respondWith(caches.match(self.registration.scope));
    }
  });
`;

test('force-update recovers from a worker serving stale pages without clearing downloaded data', async ({ page }) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/broken-worker.js' || path === '/service-worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(path === '/broken-worker.js' ? brokenWorker : 'self.addEventListener("install", () => {});');
    } else if (path === '/src/main.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('if (location.search.includes("force-update=1")) throw new Error("Dashboard module ran during recovery");');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end(shell);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server has no port.');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    await page.evaluate(async () => {
      const cache = await caches.open('central-agentic-ops-dashboard-app-broken');
      await cache.put('/', new Response(await (await fetch('/')).text(), {
        headers: { 'Content-Type': 'text/html' }
      }));
      await (await caches.open('central-agentic-ops-dashboard-data-existing')).put('/data', new Response('saved'));
      await navigator.serviceWorker.register('/broken-worker.js');
      await navigator.serviceWorker.ready;
    });
    await page.context().setOffline(true);
    await page.goto(`${origin}/?force-update=1`);
    await expect(page.locator('#root')).toContainText('A network connection is required');
    expect(await page.evaluate(async () => ({
      registered: Boolean(await navigator.serviceWorker.getRegistration()),
      caches: await caches.keys()
    }))).toEqual({
      registered: true,
      caches: expect.arrayContaining([
        'central-agentic-ops-dashboard-app-broken',
        'central-agentic-ops-dashboard-data-existing'
      ])
    });
    await page.context().setOffline(false);
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/?force-update=1`);
    await expect(page).toHaveURL(/online=1.*recovered=/);
    const result = await page.evaluate(async () => ({
      registration: await navigator.serviceWorker.getRegistration(),
      keys: await caches.keys(),
      data: await (await caches.match('/data'))?.text()
    }));
    expect(result.registration).toBeUndefined();
    expect(result.keys).not.toContain('central-agentic-ops-dashboard-app-broken');
    expect(result.keys).toContain('central-agentic-ops-dashboard-data-existing');
    expect(result.data).toBe('saved');
    expect(pageErrors).toEqual([]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  }
});
