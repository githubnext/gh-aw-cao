import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

for (const width of [1440, 390]) {
  test(`admin action streams into a read-only terminal at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    /** @type {(() => void) | undefined} */
    let finish;
    /** @type {((event: { stream: string, data: string }) => void) | undefined} */
    let emitOutput;
    let runs = 0;
    let cancellations = 0;
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', admin: true, port: 0,
      cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'),
      cliQueueAdmission: async () => ({ concurrency: 1 }),
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      lookupSelector: async () => [{ value: 'octo/example', label: 'octo/example' }],
      executeCliAction: async (/** @type {{ signal?: AbortSignal, onOutput: (event: { stream: string, data: string }) => void }} */ { onOutput, signal }) => {
        runs += 1;
        emitOutput = onOutput;
        onOutput({ stream: 'stdout', data: '\u001b[32mStarting repository setup\u001b[0m\r\nProgress: 10%' });
        await new Promise((resolve) => {
          finish = () => resolve(undefined);
          signal?.addEventListener('abort', () => { cancellations += 1; resolve(undefined); }, { once: true });
        });
        if (signal?.aborted) return { ok: false, exitCode: null, error: 'CLI action cancelled.' };
        onOutput({ stream: 'stderr', data: '\r\u001b[2KProgress: 100%\r\nRepository staged.\r\n' });
        return { ok: true, exitCode: 0 };
      },
      downloadData: async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'sources.json'), JSON.stringify({
          repositories: {
            metadata: { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' },
            rows: [{ organization: 'acme', repository: 'control', 'gh-aw-version': 'v0.91.5', 'gh-aw-current-version': 'v0.91.5' }]
          },
          workflows: {
            metadata: { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' },
            rows: [{ organization: 'acme', repository: 'control', workflow: 'demo.md', 'workflow-name': 'Demo',
              'gh-aw-version': 'v0.91.5', 'gh-aw-current-version': 'v0.91.5' }]
          }
        }));
      }
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${preview.url}/#page-maintenance`);
      const trigger = page.getByRole('button', { name: 'Add repository', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Approve Add repository' });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(runs).toBe(0);
      await trigger.click();
      await dialog.getByRole('searchbox', { name: 'Repository', exact: true }).fill('octo');
      await dialog.getByRole('button', { name: 'octo/example', exact: true }).click();
      expect(runs).toBe(0);
      const confirm = dialog.getByRole('button', { name: 'Add repository', exact: true, includeHidden: true });
      const terminalOption = dialog.getByRole('checkbox', { name: 'Open terminal window' });
      const terminalDialog = page.getByRole('dialog', { name: 'Terminal: Add repository', exact: true });
      const status = dialog.locator(':scope > footer .cli-action-status');
      await expect(terminalOption).not.toBeChecked();
      await confirm.click();
      await expect.poll(() => runs).toBe(1);
      await expect(confirm).toBeHidden();
      await expect(dialog.locator(':scope > footer button:visible')).toHaveText(['Cancel command', 'Detach']);
      await expect(terminalDialog).not.toBeVisible();
      await expect(dialog.getByRole('region', { name: 'Read-only command terminal' })).toBeVisible();
      finish?.();
      await expect(status).toHaveText('Completed');
      await terminalOption.check();
      const terminal = terminalDialog.getByRole('region', { name: 'Read-only command terminal' });
      await expect(terminal).toBeVisible();
      await expect(terminalDialog.getByRole('button', { name: 'Cancel command', includeHidden: true })).toBeHidden();
      const originalTerminal = await terminal.elementHandle();
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Starting repository setup');
      expect(runs).toBe(1);
      await terminal.click();
      await page.keyboard.type('this must not reach the command');
      await expect(terminal.locator('.xterm-accessibility-tree')).not.toContainText('this must not reach');
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Progress: 100%');
      await expect(terminal.locator('.xterm-accessibility-tree')).not.toContainText('Progress: 10%');
      const bounds = await terminalDialog.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      const screenshot = testInfo.outputPath(`admin-terminal-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`admin-terminal-${width}`, { path: screenshot, contentType: 'image/png' });
      await terminalDialog.getByRole('button', { name: 'Close terminal window', exact: true }).click();
      await expect(dialog.getByRole('region', { name: 'Read-only command terminal' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close action approval' }).click();
      await expect(trigger).toBeFocused();
      await trigger.click();
      expect(runs).toBe(1);
      await expect(terminalOption).not.toBeChecked();
      await expect(terminal).not.toBeVisible();
      await dialog.getByRole('searchbox', { name: 'Repository', exact: true }).fill('octo');
      await dialog.getByRole('button', { name: 'octo/example', exact: true }).click();
      await terminalOption.check();
      expect(runs).toBe(1);
      await expect(terminalDialog).not.toBeVisible();
      await confirm.click();
      await expect.poll(() => runs).toBe(2);
      await expect(terminalDialog).toBeVisible();
      await expect(confirm).toBeDisabled();
      expect(await originalTerminal?.evaluate((element) => element === document.querySelector('.cli-action-terminal'))).toBe(true);
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Repository staged.');
      await expect(terminalDialog.locator(':scope > footer button:visible')).toHaveText(['Cancel command', 'Close terminal']);
      await page.keyboard.press('Escape');
      await expect(terminalDialog).not.toBeVisible();
      expect(cancellations).toBe(0);
      await expect(dialog.getByRole('region', { name: 'Read-only command terminal' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel command', exact: true }).click();
      await expect(status).toHaveText('Cancelled. Completed changes are not undone.');
      await expect.poll(() => cancellations).toBe(1);
      await terminalOption.check();
      await expect(dialog).toBeVisible();
      await expect(terminal).toBeVisible();
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Cancelled.');
      const cancelledScreenshot = testInfo.outputPath(`admin-terminal-cancelled-${width}.png`);
      await page.screenshot({ path: cancelledScreenshot, fullPage: true });
      await testInfo.attach(`admin-terminal-cancelled-${width}`, { path: cancelledScreenshot, contentType: 'image/png' });
      await terminalDialog.getByRole('button', { name: 'Close terminal window', exact: true }).click();
      await expect(confirm).toBeHidden();
      await dialog.getByRole('button', { name: 'Close action approval' }).click();
      await trigger.click();
      await dialog.getByRole('searchbox', { name: 'Repository', exact: true }).fill('octo');
      await dialog.getByRole('button', { name: 'octo/example', exact: true }).click();
      await confirm.click();
      await expect.poll(() => runs).toBe(3);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      expect(cancellations).toBe(1);
      finish?.();

      await page.getByRole('button', { name: 'Upgrade', exact: true }).first().click();
      const upgradeDialog = page.getByRole('dialog', { name: 'Approve Upgrade', exact: true });
      expect(runs).toBe(3);
      await upgradeDialog.getByRole('button', { name: 'Upgrade', exact: true }).click();
      await expect.poll(() => runs).toBe(4);
      await expect(upgradeDialog.locator(':scope > footer button:visible')).toHaveText(['Cancel command', 'Detach']);
      await expect(upgradeDialog.locator('.cli-action-command')).toBeHidden();
      await expect(upgradeDialog.locator('.cli-action-arguments')).toBeHidden();
      await expect(upgradeDialog.getByRole('checkbox', { name: 'Open terminal window', includeHidden: true })).toBeHidden();
      await expect(upgradeDialog.locator(':scope > header')).toBeHidden();
      expect(await upgradeDialog.boundingBox()).toEqual({ x: 0, y: 0, width, height: 900 });
      const inlineTerminal = upgradeDialog.getByRole('region', { name: 'Read-only command terminal' });
      await expect(inlineTerminal).toBeVisible();
      expect((await inlineTerminal.boundingBox())?.height).toBeGreaterThan(800);
      await expect(inlineTerminal.locator('.xterm-accessibility-tree')).toContainText('Starting repository setup');
      emitOutput?.({
        stream: 'stdout',
        data: '\r\n' + Array.from({ length: 120 }, (_, index) => `Output line ${index + 1}\r\n`).join('')
      });
      const viewport = inlineTerminal.locator('.xterm-viewport');
      await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(100);
      await expect(inlineTerminal.locator('.xterm-accessibility-tree')).toContainText('Output line 120');
      await viewport.evaluate((element) => { element.scrollTop = 0; });
      await expect(inlineTerminal.locator('.xterm-accessibility-tree')).toContainText('Starting repository setup');
      await expect(inlineTerminal.locator('textarea')).toHaveAttribute('readonly', '');
      const url = 'https://example.com/cli-result';
      await page.context().route(url, (route) => route.fulfill({ body: 'Terminal link fixture' }));
      await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      emitOutput?.({ stream: 'stdout', data: 'https://example.com/' });
      emitOutput?.({ stream: 'stdout', data: 'cli-result\r\n' });
      const linkRow = inlineTerminal.locator('.xterm-accessibility-tree').getByText(url, { exact: true });
      await expect(linkRow).toBeVisible();
      const linkBounds = await linkRow.boundingBox();
      if (!linkBounds) throw new Error('Expected a rendered terminal URL.');
      const linkPoint = { x: linkBounds.x + 30, y: linkBounds.y + linkBounds.height / 2 };
      await page.mouse.move(linkPoint.x, linkPoint.y);
      await expect(inlineTerminal.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
      const opened = page.waitForEvent('popup');
      await page.mouse.click(linkPoint.x, linkPoint.y);
      const popup = await opened;
      await expect(popup).toHaveURL(url);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
      await expect(upgradeDialog.getByRole('button', { name: 'Cancel command', exact: true })).toBeVisible();
      const inlineScreenshot = testInfo.outputPath(`admin-inline-terminal-${width}.png`);
      await page.screenshot({ path: inlineScreenshot, fullPage: true });
      await testInfo.attach(`admin-inline-terminal-${width}`, { path: inlineScreenshot, contentType: 'image/png' });
      await upgradeDialog.getByRole('button', { name: 'Cancel command', exact: true }).click();
      await expect.poll(() => cancellations).toBe(2);
      await expect(inlineTerminal).toBeVisible();
      await expect(upgradeDialog.locator(':scope > footer button:visible')).toHaveText(['Close']);
    } finally {
      finish?.();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
