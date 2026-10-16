import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);
/** @type {(command: string) => string[]} */
const parseDashboardCommand = (await import(new URL('../../../cli-actions.mjs', import.meta.url).href)).parseDashboardCommand;

for (const width of [1440, 390]) {
  test(`Upgrade all lists and queues every repository at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const repositories = ['octo/first', 'other/second', 'octo/third'];
    const campaigns = ['activity', 'dependabot'];
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
          campaigns: { metadata, rows: campaigns.map((campaign) => ({
            campaign, 'campaign-name': campaign, 'campaign-version': 'v1',
            'campaign-current-version': 'v2', 'campaign-update-state': 'update-available',
            'campaign-registration': 'true'
          })) },
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
      const upgradeDialog = page.getByRole('dialog', { name: 'Approve Upgrade all', exact: true });
      await expect(upgradeDialog).toBeVisible();
      const autoMerge = upgradeDialog.getByRole('checkbox', { name: 'Auto merge' });
      await expect(autoMerge).not.toBeChecked();
      expect(commands).toEqual([]);
      if (width === 1440) {
        await autoMerge.check();
        await expect(upgradeDialog.locator('.cli-action-command')).toContainText('--auto-merge');
      }
      await page.screenshot({ path: testInfo.outputPath(`upgrade-options-${width}.png`), fullPage: true });
      await upgradeDialog.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      await expect(page).toHaveURL(/#page-commands$/);
      await expect(page.getByRole('dialog', { name: 'Approve Upgrade all', exact: true })).not.toBeVisible();
      await expect(page.locator('[data-view-id="commands-history"]')).toContainText('running');
      await expect.poll(async () => page.evaluate(async () => {
        const response = await fetch('./__cli_commands?limit=50');
        if (!response.ok) throw new Error(`Command history failed: HTTP ${response.status}`);
        return (await response.json()).total;
      })).toBe(3);
      const screenshot = testInfo.outputPath(`upgrade-all-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`upgrade-all-${width}`, { path: screenshot, contentType: 'image/png' });
      finish();
      await expect.poll(() => commands.length).toBe(3);
      const upgrades = commands.map(parseDashboardCommand);
      expect(upgrades.map((tokens) => tokens[4]).sort()).toEqual([...repositories].sort());
      for (const tokens of upgrades) {
        expect(tokens.slice(0, 4)).toEqual(['gh', 'aw', 'upgrade', '--repo']);
        expect(tokens[5]).toBe('--pr-message');
        expect(tokens[6]).toContain(`to upgrade GitHub Agentic Workflows in ${tokens[4]}`);
        expect(tokens[6]).toContain('[Central Agentic Ops (CAO)](https://github.com/githubnext/gh-aw-cao)');
        expect(tokens[6]).toContain('[CAO dashboard](https://githubnext.github.io/gh-aw-cao/cao/#page-maintenance)');
        expect(tokens.slice(7)).toEqual(['--create-pull-request', ...(width === 1440 ? ['--auto-merge'] : [])]);
      }
      await expect(page.locator('[data-view-id="commands-history"]')).toContainText('completed');
      expect(commands).toHaveLength(3);
      await page.evaluate(() => { window.location.hash = 'page-maintenance-campaigns'; });
      await page.getByRole('button', { name: 'Update all', exact: true }).click();
      const updateDialog = page.getByRole('dialog', { name: 'Approve Update all', exact: true });
      await expect(updateDialog).toBeVisible();
      await expect(updateDialog.getByRole('checkbox', { name: 'Auto merge' })).not.toBeChecked();
      await updateDialog.getByRole('checkbox', { name: 'Auto merge' }).check();
      await expect(updateDialog.locator('.cli-action-command')).toContainText('--auto-merge');
      await updateDialog.getByRole('button', { name: 'Update all', exact: true }).click();
      await expect(page).toHaveURL(/#page-commands$/);
      await expect(page.getByRole('dialog', { name: 'Approve Update all', exact: true })).not.toBeVisible();
      await expect.poll(() => commands.length).toBe(5);
      const updates = commands.slice(3).map(parseDashboardCommand);
      expect(updates.map((tokens) => tokens[3]).sort()).toEqual([...campaigns].sort());
      for (const tokens of updates) {
        expect(tokens.slice(0, 3)).toEqual(['./cao.sh', 'update', '--campaign']);
        expect(tokens[4]).toBe('--pr-message');
        expect(tokens[5]).toContain(`to update the ${tokens[3]} campaign from its upstream source`);
        expect(tokens[5]).toContain('[Central Agentic Ops (CAO)](https://github.com/githubnext/gh-aw-cao)');
        expect(tokens[5]).toContain('[CAO dashboard](https://githubnext.github.io/gh-aw-cao/cao/#page-maintenance-campaigns)');
        expect(tokens.slice(6)).toEqual(['--create-pull-request', '--auto-merge']);
      }
      const campaignScreenshot = testInfo.outputPath(`campaigns-queued-${width}.png`);
      await expect(page.locator('[data-view-id="commands-history"]')).toContainText('./cao.sh update --campaign activity');
      await page.screenshot({ path: campaignScreenshot, fullPage: true });
      await testInfo.attach(`campaigns-queued-${width}`, { path: campaignScreenshot, contentType: 'image/png' });
    } finally {
      finish();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
