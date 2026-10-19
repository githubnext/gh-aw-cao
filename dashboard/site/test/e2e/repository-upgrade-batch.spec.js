import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { startDashboardServer, publishNativeFixture, nativeExecutable } from '../../../../tests/helpers/native-dashboard.mjs';
import { nativeCommandFixture } from '../../../../tests/helpers/native-command-fixture.mjs';
/** @type {(command: string) => string[]} */
const parseDashboardCommand = (command) => JSON.parse(execFileSync(nativeExecutable,
  ['dashboard', 'action', '--validate', '--command', command], { encoding: 'utf8' }));

for (const width of [1440, 390]) {
  test(`Upgrade copy dialog contains clicks inside the repository card at ${width}px`, async ({ page }, testInfo) => {
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', caoUrl: 'https://ops.example.com/central/', port: 0,
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      downloadData: publishNativeFixture(async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        const metadata = { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' };
        await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify({
          repositories: { metadata, rows: [{ organization: 'octo', repository: 'example' }] },
          workflows: { metadata, rows: [{
            organization: 'octo', repository: 'example', workflow: 'demo.md', 'workflow-name': 'Demo',
            'gh-aw-version': 'v0.91.5', 'gh-aw-current-version': 'v0.92.0'
          }] }
        }));
      })
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${preview.url}/#page-maintenance`);
      const repositoryLink = page.locator('[data-view-id="maintenance-repositories"] [data-card-drill="external"]');
      await expect(repositoryLink).toHaveCount(1);
      await repositoryLink.evaluate((link) => {
        link.addEventListener('click', () => link.setAttribute('data-test-activated', 'true'));
      });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (/** @type {string} */ text) => { document.body.dataset.copiedCommand = text; } }
        });
      });
      const trigger = page.getByRole('button', { name: 'Upgrade', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Approve Upgrade', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByText('Upgrade Agentic Workflows in the selected repository and create a pull request.', { exact: true }).click();
      await expect(repositoryLink).not.toHaveAttribute('data-test-activated');
      await dialog.getByText('Include pre-releases', { exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: 'Include pre-releases' })).toBeChecked();
      await expect(dialog.locator('.cli-action-command')).toContainText('--pre-releases');
      await dialog.getByText('Auto merge', { exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: 'Auto merge' })).toBeChecked();
      await expect(dialog.locator('.cli-action-command')).toContainText('--auto-merge');
      await dialog.locator('.cli-action-command').click();
      await dialog.getByRole('button', { name: 'Copy command', exact: true }).click();
      await expect(dialog.locator('.cli-action-status')).toHaveText('Command copied.');
      await expect(page.locator('body')).toHaveAttribute('data-copied-command', /gh aw upgrade --repo octo\/example.*--pre-releases.*--auto-merge/);
      await expect(repositoryLink).not.toHaveAttribute('data-test-activated');
      await expect(page).toHaveURL(/#page-maintenance$/);
      const screenshot = testInfo.outputPath(`upgrade-copy-dialog-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`upgrade-copy-dialog-${width}`, { path: screenshot, contentType: 'image/png' });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(repositoryLink).not.toHaveAttribute('data-test-activated');
    } finally {
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}

for (const { width, canExecute } of [
  { width: 1440, canExecute: true }, { width: 390, canExecute: true },
  { width: 1440, canExecute: false }, { width: 390, canExecute: false }
]) {
  test(`Upgrade all lists and ${canExecute ? 'queues' : 'copies'} every repository at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const repositories = ['octo/first', 'other/second', 'octo/third'];
    const campaigns = ['activity', 'dependabot'];
    /** @type {string[]} */
    const commands = [];
    /** @type {() => void} */
    let finish = () => {};
    const commandFixture = await nativeCommandFixture(testInfo.outputPath('external-cli'), {
      onCommand: (command) => commands.push(command)
    });
    finish = commandFixture.finish;
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', caoUrl: 'https://ops.example.com/central/', admin: canExecute, port: 0,
      commandFixture,
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      downloadData: publishNativeFixture(async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        const metadata = { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' };
        await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify({
          campaigns: { metadata, rows: campaigns.map((campaign) => ({
            campaign, 'campaign-name': campaign, 'campaign-version': 'v1',
            'campaign-current-version': 'v2', 'campaign-update-state': 'update-available',
            'campaign-registration': 'true'
          })) },
          repositories: { metadata, rows: repositories.map((coordinate) => {
            const [organization, repository] = coordinate.split('/');
            return { organization, repository };
          }) },
          workflows: { metadata: { ...metadata, completeness: 'partial' }, rows: repositories.map((coordinate) => {
            const [organization, repository] = coordinate.split('/');
            return { organization, repository, workflow: 'demo.md', 'workflow-name': 'Demo',
              'gh-aw-version': 'v0.91.5', 'gh-aw-current-version': 'v0.92.0' };
          }) }
        }));
      })
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
      await page.getByRole('button', { name: 'Upgrade', exact: true }).first().click();
      const rowDialog = page.getByRole('dialog', { name: 'Approve Upgrade', exact: true });
      await expect(rowDialog).toBeVisible();
      await expect(rowDialog.locator('.cli-action-command')).toContainText('https://github.com/acme/control');
      await expect(rowDialog.locator('.cli-action-command')).toContainText('https://ops.example.com/central/#page-maintenance');
      await rowDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(commands).toEqual([]);
      await page.getByRole('button', { name: 'Upgrade all', exact: true }).click();
      const upgradeDialog = page.getByRole('dialog', { name: 'Approve Upgrade all', exact: true });
      await expect(upgradeDialog).toBeVisible();
      await expect(upgradeDialog.getByRole('note')).toContainText('Inventory evidence is partial.');
      for (const repository of repositories) {
        await expect(upgradeDialog.locator('.cli-action-command')).toContainText(`--repo ${repository}`);
      }
      await expect(upgradeDialog.locator('.cli-action-command')).toContainText('https://ops.example.com/central/#page-maintenance');
      await expect(upgradeDialog.locator('.cli-action-command')).not.toContainText(new URL(preview.url).pathname);
      const autoMerge = upgradeDialog.getByRole('checkbox', { name: 'Auto merge' });
      const compactPreview = upgradeDialog.locator('.cli-action-preview-command');
      const fullCommands = upgradeDialog.locator('.cli-action-command');
      await expect(compactPreview).toBeVisible();
      await expect(compactPreview).toHaveText(`gh aw upgrade --repo ${repositories[0]} --create-pull-request`);
      await expect(compactPreview).not.toContainText('--pr-message');
      await expect(fullCommands).not.toBeVisible();
      await expect(upgradeDialog.getByText('Preview for the first of 3 targets:', { exact: true })).toBeVisible();
      await upgradeDialog.getByText('Show all 3 full commands', { exact: true }).click();
      await expect(fullCommands).toBeVisible();
      await expect(fullCommands).toContainText('--pr-message');
      await upgradeDialog.getByText('Show all 3 full commands', { exact: true }).click();
      await expect(fullCommands).not.toBeVisible();
      await expect(autoMerge).not.toBeChecked();
      expect(commands).toEqual([]);
      if (width === 1440) {
        await autoMerge.check();
        await expect(compactPreview).toContainText('--auto-merge');
        await expect(upgradeDialog.locator('.cli-action-command')).toContainText('--auto-merge');
      }
      const optionsScreenshot = testInfo.outputPath(`upgrade-options-${width}.png`);
      await page.screenshot({ path: optionsScreenshot, fullPage: true });
      await testInfo.attach(`upgrade-options-${width}`, { path: optionsScreenshot, contentType: 'image/png' });
      if (!canExecute) {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const fullCommandText = await fullCommands.textContent();
        await upgradeDialog.getByRole('button', { name: 'Copy command', exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullCommandText);
        expect(fullCommandText?.split('\n')).toHaveLength(repositories.length);
        expect(fullCommandText).toContain('--pr-message');
        expect(fullCommandText).not.toContain('The complete target list is unavailable.');
        expect(commands).toEqual([]);
        await expect(page).toHaveURL(/#page-maintenance$/);
        return;
      }
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
        expect(tokens[6]).toContain('[Central Agentic Ops (CAO)](https://github.com/acme/control)');
        expect(tokens[6]).toContain('[CAO dashboard](https://ops.example.com/central/#page-maintenance)');
        expect(tokens.slice(7)).toEqual(['--create-pull-request', ...(width === 1440 ? ['--auto-merge'] : [])]);
      }
      await expect(page.locator('[data-view-id="commands-history"]')).toContainText('completed');
      expect(commands).toHaveLength(3);
      await page.evaluate(() => { window.location.hash = 'page-maintenance-campaigns'; });
      await page.getByRole('button', { name: 'Update all', exact: true }).click();
      const updateDialog = page.getByRole('dialog', { name: 'Approve Update all', exact: true });
      await expect(updateDialog).toBeVisible();
      await expect(updateDialog.locator('.cli-action-preview-command')).toHaveText('gh aw update https://github.com/githubnext/gh-aw-cao/activity --repo acme/control --create-pull-request');
      await expect(updateDialog.locator('.cli-action-command')).not.toBeVisible();
      await expect(updateDialog.getByRole('checkbox', { name: 'Auto merge' })).not.toBeChecked();
      await updateDialog.getByRole('checkbox', { name: 'Auto merge' }).check();
      await expect(updateDialog.locator('.cli-action-command')).toContainText('--auto-merge');
      await updateDialog.getByRole('button', { name: 'Update all', exact: true }).click();
      await expect(page).toHaveURL(/#page-commands$/);
      await expect(page.getByRole('dialog', { name: 'Approve Update all', exact: true })).not.toBeVisible();
      await expect.poll(() => commands.length).toBe(5);
      const updates = commands.slice(3).map(parseDashboardCommand);
      expect(updates.map((tokens) => tokens[3].split('/').at(-1)).sort()).toEqual([...campaigns].sort());
      for (const tokens of updates) {
        expect(tokens.slice(0, 3)).toEqual(['gh', 'aw', 'update']);
        expect(tokens[3]).toMatch(/^https:\/\/github\.com\/githubnext\/gh-aw-cao\//);
        expect(tokens.slice(4, 7)).toEqual(['--repo', 'acme/control', '--pr-message']);
        expect(tokens[7]).toContain(`to update the ${tokens[3].split('/').at(-1)} campaign from its upstream source`);
        expect(tokens[7]).toContain('[Central Agentic Ops (CAO)](https://github.com/acme/control)');
        expect(tokens[7]).toContain('[CAO dashboard](https://ops.example.com/central/#page-maintenance-campaigns)');
        expect(tokens.slice(8)).toEqual(['--create-pull-request', '--auto-merge']);
      }
      const campaignScreenshot = testInfo.outputPath(`campaigns-queued-${width}.png`);
      await expect(page.locator('[data-view-id="commands-history"]')).toContainText('gh aw update https://github.com/githubnext/gh-aw-cao/activity');
      await page.screenshot({ path: campaignScreenshot, fullPage: true });
      await testInfo.attach(`campaigns-queued-${width}`, { path: campaignScreenshot, contentType: 'image/png' });
    } finally {
      finish();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
