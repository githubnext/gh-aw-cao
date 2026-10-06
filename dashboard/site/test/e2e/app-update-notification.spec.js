import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';

const workerSource = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');

test('a downloaded app update waits for the user to reload', async ({ page }) => {
  let version = 'first';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/switch') {
      version = 'second';
      response.writeHead(200);
      response.end();
    } else if (pathname === '/service-worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(workerSource.replace("const VERSION = 'development';", `const VERSION = '${version}';`));
    } else if (pathname.startsWith('/src/') && /^\/src\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(readFileSync(new URL(`../..${pathname}`, import.meta.url)));
    } else if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<script>sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1)</script>');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server has no port.');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/service-worker.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
    });
    await page.request.get(`${origin}/switch`);
    await page.evaluate(async (moduleUrl) => {
      const { startDashboardAppUpdates } = await import(moduleUrl);
      startDashboardAppUpdates();
    }, `${origin}/src/dashboard-data-updates.js`);

    await expect(page.locator('.dashboard-notification-message')).toHaveText('An update to the dashboard has been downloaded. Update now?');
    expect(await page.evaluate(() => sessionStorage.loads)).toBe('1');
    await page.getByRole('button', { name: 'Update now' }).click();
    await expect.poll(() => page.evaluate(() => sessionStorage.loads)).toBe('2');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  }
});
