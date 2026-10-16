import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

for (const width of [1440, 390]) {
  test(`Upgrade all lists and queues every repository at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const repositories = ['octo/first', 'other/second', 'octo/third'];
    /** @type {string[]} */
    const commands = [];
    /** @type {() => void} */
    let finish = () => {};
    const execution = new Promise((resolve) => { finish = () => resolve(undefined); });
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', admin: true, port: 0,
      cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'),
      cliQueueAdmission: async () => ({ concurrency: 1 }),
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      executeCliAction: async (/** @type {{ command: string }} */ { command }) => {
        commands.push(command);
        await execution;
        return { ok: true, exitCode: 0 };
      },
      downloadData: async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        const metadata = { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' };
        await writeFile(join(destination, 'sources.json'), JSON.stringify({
          repositories: { metadata, rows: repositories.map((coordinate) => {
            const [organization, repository] = coordinate.split('/');
            return { organization, repository };
          }) },
          workflows: { metadata, rows: repositories.map((coordinate) => {
            const [organization, repository] = coordinate.split('/');
            return { organization, repository, workflow: 'demo.md', 'workflow-name': 'Demo',
              'gh-aw-version': 'v0.91.5', 'gh-aw-current-version': 'v0.92.0' };
          }) }
        }));
      }
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${preview.url}/#page-maintenance`);
      const repositoryLinks = page.locator('[data-view-id="maintenance-repositories"] [data-card-drill="external"]');
      await expect(repositoryLinks).toHaveCount(repositories.length);
      for (const repository of repositories) {
        await expect(repositoryLinks.filter({ hasText: repository })).toHaveAttribute('href', `https://github.com/${repository}`);
      }
      const repositoriesScreenshot = testInfo.outputPath(`updates-repositories-${width}.png`);
      await page.screenshot({ path: repositoriesScreenshot, fullPage: true });
      await testInfo.attach(`updates-repositories-${width}`, { path: repositoriesScreenshot, contentType: 'image/png' });
      const repositoryHome = `https://github.com/${repositories[0]}`;
      await page.context().route(repositoryHome, (route) => route.fulfill({ body: 'Repository home fixture' }));
      const openedRepository = page.waitForEvent('popup');
      await repositoryLinks.filter({ hasText: repositories[0] }).click();
      const repositoryPage = await openedRepository;
      await expect(repositoryPage).toHaveURL(repositoryHome);
      expect(await repositoryPage.evaluate(() => window.opener === null)).toBe(true);
      await repositoryPage.close();
      await expect(page).toHaveURL(/#page-maintenance$/);
      expect(commands).toEqual([]);
      await page.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Approve Upgrade all', exact: true });
      await expect(dialog.locator('.cli-action-command')).toHaveText([
        'gh aw upgrade --repo octo/first --create-pull-request',
        'gh aw upgrade --repo octo/third --create-pull-request',
        'gh aw upgrade --repo other/second --create-pull-request'
      ].join('\n'));
      expect(commands).toEqual([]);
      const screenshot = testInfo.outputPath(`upgrade-all-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`upgrade-all-${width}`, { path: screenshot, contentType: 'image/png' });
      await dialog.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      await expect.poll(async () => page.evaluate(async () => {
        const response = await fetch('./__cli_commands?limit=50');
        if (!response.ok) throw new Error(`Command history failed: HTTP ${response.status}`);
        return (await response.json()).total;
      })).toBe(3);
      await dialog.getByRole('button', { name: 'Close action approval', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      finish();
      await expect.poll(() => commands.length).toBe(3);
      expect(commands.sort()).toEqual(repositories.map((repository) =>
        `gh aw upgrade --repo ${repository} --create-pull-request`).sort());
      await page.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      await dialog.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      const completionLink = page.getByRole('link', { name: 'Upgrade all: Completed', exact: true });
      await expect(completionLink).toBeVisible();
      await expect(completionLink).toHaveAttribute('href', '#page-commands');
      await expect(dialog).not.toBeVisible();
      const completionScreenshot = testInfo.outputPath(`upgrade-complete-link-${width}.png`);
      await page.screenshot({ path: completionScreenshot, fullPage: true });
      await testInfo.attach(`upgrade-complete-link-${width}`, { path: completionScreenshot, contentType: 'image/png' });
      await completionLink.click();
      await expect(page).toHaveURL(/#page-commands$/);
      await expect(page.locator('[data-view-id="commands-history"]')).toBeVisible();
      expect(commands).toHaveLength(6);
    } finally {
      finish();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
