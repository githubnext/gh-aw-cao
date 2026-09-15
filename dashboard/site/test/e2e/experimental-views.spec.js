import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const buildScript = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url));
const sourceDashboard = JSON.parse(readFileSync(new URL('../../dashboard.json', import.meta.url), 'utf8'));
const policy = JSON.parse(readFileSync(new URL('../../../../.github/workflows/cao.json', import.meta.url), 'utf8'));
const sourceNavigation = /** @type {Array<{ label?: string, experimental?: boolean, pages: string[] }>} */ (
  sourceDashboard.dashboard.navigation
);
const experimentalSections = sourceNavigation.filter((section) => section.experimental === true);

test('repository policy exposes every experimental dashboard page and route', async ({ page, context }) => {
  expect(policy['control-plane'].web.experimental).toBe(true);

  const root = mkdtempSync(join(tmpdir(), 'cao-experimental-views-'));
  try {
    const settingsPath = join(root, 'control-settings.json');
    writeFileSync(settingsPath, JSON.stringify(policy['control-plane']));
    execFileSync(process.execPath, [buildScript, root, settingsPath]);

    await context.route('http://experimental.dashboard.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<main>Dashboard</main>' });
        return;
      }

      const filePath = join(root, pathname, pathname.endsWith('/') ? 'index.html' : '');
      if (!existsSync(filePath)) {
        await route.fulfill({ status: 404 });
        return;
      }
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'text/html',
        body: readFileSync(filePath),
      });
    });

    await page.goto('http://experimental.dashboard.test/');
    const assembledDashboard = await page.evaluate(async () => (
      fetch('/dashboard.json').then((response) => response.json())
    ));
    const assembledSections = assembledDashboard.dashboard.navigation;
    const assembledPages = /** @type {Array<{ id: string }>} */ (assembledDashboard.dashboard.pages);
    const assembledPageIds = new Set(assembledPages.map((candidate) => candidate.id));

    for (const section of experimentalSections) {
      expect(assembledSections).toContainEqual(section);
      for (const pageId of section.pages) {
        expect(assembledPageIds.has(pageId)).toBe(true);
        await page.goto(`http://experimental.dashboard.test/${pageId}/`);
        await expect(page).toHaveURL(`http://experimental.dashboard.test/#page-${pageId}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
