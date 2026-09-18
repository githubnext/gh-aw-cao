import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (fileName === 'src/main.js') {
      await route.fulfill({ contentType: 'application/javascript', body: '' });
      return;
    }
    /** @type {Record<string, string>} */
    const contentTypes = {
      '.html': 'text/html',
      '.json': 'application/manifest+json',
      '.js': 'text/javascript',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    const extension = fileName.slice(fileName.lastIndexOf('.'));
    await route.fulfill({
      contentType: contentTypes[extension] ?? 'application/octet-stream',
      body: readFileSync(new URL(`../../${fileName}`, import.meta.url))
    });
  });
});

test('desktop browser exposes an installable dashboard application', async ({ page }, testInfo) => {
  await page.goto('http://localhost/');

  await expect(page.locator('meta[name="viewport"]'))
    .toHaveAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', './manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', './apple-touch-icon.png');
  await expect(page.locator('meta[name="application-name"]'))
    .toHaveAttribute('content', 'Central Agentic Ops Dashboard');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d1117');
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Agentic Ops');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]'))
    .toHaveAttribute('content', 'black');

  const result = await page.evaluate(async () => {
    const manifestUrl = /** @type {HTMLLinkElement | null} */ (
      document.querySelector('link[rel="manifest"]')
    )?.href;
    if (!manifestUrl) throw new Error('Web app manifest link is missing.');
    const response = await fetch(manifestUrl);
    return {
      manifest: await response.json(),
      serviceWorkerSupported: 'serviceWorker' in navigator,
      userAgent: navigator.userAgent
    };
  });

  expect(result.serviceWorkerSupported).toBe(true);
  expect(result.manifest).toMatchObject({
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    display_override: ['minimal-ui', 'standalone']
  });
  if (testInfo.project.name === 'desktop-edge') expect(result.userAgent).toContain('Edg/');
  if (testInfo.project.name === 'desktop-safari') {
    expect(result.userAgent).toContain('Safari/');
    expect(result.userAgent).not.toContain('Chrome/');
  }
  if (testInfo.project.name === 'desktop-chrome') {
    expect(result.userAgent).toContain('Chrome/');
    expect(result.userAgent).not.toContain('Edg/');
  }
});

test('renders Octicons from an inlined sprite instead of an external reference', async ({ page }) => {
  await page.goto('http://localhost/');

  const icon = await page.evaluate(async (moduleUrl) => {
    const { ensureOcticonSprite, octicon } = await import(moduleUrl);
    await ensureOcticonSprite();
    const rendered = octicon('rocket');
    document.body.append(rendered);
    const glyph = rendered.querySelector('use');
    return {
      href: glyph?.getAttribute('href') ?? '',
      symbolPresent: Boolean(document.querySelector('#octicon-sprite #octicon-rocket')),
      width: glyph?.getBoundingClientRect().width ?? 0,
      height: glyph?.getBoundingClientRect().height ?? 0
    };
  }, 'http://localhost/src/octicons.js');

  expect(icon.href).toBe('#octicon-rocket');
  expect(icon.symbolPresent).toBe(true);
  expect(icon.width).toBeGreaterThan(0);
  expect(icon.height).toBeGreaterThan(0);
});
