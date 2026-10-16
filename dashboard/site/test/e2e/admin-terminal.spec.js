import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

for (const width of [1440, 390]) {
  test(`admin action opens a persistent full-view terminal at ${width}px`, async ({ page }, testInfo) => {
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
        onOutput({ stream: 'stdout', data: '\r\u001b[2KProgress: 100%\r\n' });
        onOutput({ stream: 'stderr', data: 'Repository staged.\r\n' });
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
      const approval = page.getByRole('dialog', { name: 'Approve Add repository' });
      await approval.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(approval).not.toBeVisible();
      expect(runs).toBe(0);
      await trigger.click();
      await approval.getByRole('searchbox', { name: 'Repository', exact: true }).fill('octo');
      await approval.getByRole('button', { name: 'octo/example', exact: true }).click();
      expect(runs).toBe(0);
      await approval.getByRole('button', { name: 'Add repository', exact: true }).click();
      await expect.poll(() => runs).toBe(1);
      const consoleView = page.getByRole('region', { name: 'Command console log', exact: true });
      const terminal = consoleView.getByRole('region', { name: 'Read-only command terminal' });
      const back = page.getByRole('button', { name: 'Back to Commands', exact: true });
      await expect(consoleView).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(back).toBeVisible();
      await expect(terminal).toBeVisible();
      await expect(terminal).toHaveCSS('border-top-width', '0px');
      await expect(terminal).toHaveCSS('border-right-width', '0px');
      await expect(terminal).toHaveCSS('border-bottom-width', '0px');
      await expect(terminal).toHaveCSS('border-left-width', '0px');
      await expect(page.locator('#page-title')).toHaveText('./cao.sh add --repository octo/example');
      const subtitle = page.locator('.overview-header [data-page-description]');
      await expect(subtitle).toBeVisible();
      await expect(subtitle).toContainText('running');
      await expect(consoleView.locator('header')).toHaveCount(0);
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Starting repository setup');
      await terminal.click();
      await page.keyboard.type('this must not reach the command');
      await expect(terminal.locator('.xterm-accessibility-tree')).not.toContainText('this must not reach');
      await expect(terminal.locator('textarea')).toHaveAttribute('readonly', '');
      const bounds = await terminal.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(bounds?.height).toBeGreaterThan(400);
      const mainBounds = await page.locator('.app-main').boundingBox();
      expect(bounds?.x).toBe(mainBounds?.x);
      expect(bounds?.width).toBe(mainBounds?.width);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBe(900);
      const cancel = consoleView.getByRole('button', { name: 'Cancel command', exact: true });
      await expect(cancel).toHaveText('Cancel');
      const cancelBounds = await cancel.boundingBox();
      expect(cancelBounds?.height).toBeGreaterThanOrEqual(44);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0) - ((cancelBounds?.x ?? 0) + (cancelBounds?.width ?? 0))).toBe(16);
      expect(900 - ((cancelBounds?.y ?? 0) + (cancelBounds?.height ?? 0))).toBe(16);

      emitOutput?.({
        stream: 'stdout',
        data: '\r\n' + Array.from({ length: 120 }, (_, index) => `Output line ${index + 1}\r\n`).join('')
      });
      const viewport = terminal.locator('.xterm-viewport');
      await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(100);
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Output line 120');
      await viewport.evaluate((element) => { element.scrollTop = 0; });
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Starting repository setup');
      const url = 'https://example.com/cli-result';
      await page.context().route(url, (route) => route.fulfill({ body: 'Terminal link fixture' }));
      await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      emitOutput?.({ stream: 'stdout', data: 'https://example.com/' });
      emitOutput?.({ stream: 'stdout', data: 'cli-result\r\n' });
      const linkRow = terminal.locator('.xterm-accessibility-tree').getByText(url, { exact: true });
      await expect(linkRow).toBeVisible();
      const linkBounds = await linkRow.boundingBox();
      if (!linkBounds) throw new Error('Expected a rendered terminal URL.');
      const point = { x: linkBounds.x + 30, y: linkBounds.y + linkBounds.height / 2 };
      await page.mouse.move(point.x, point.y);
      await expect(terminal.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
      const opened = page.waitForEvent('popup');
      await page.mouse.click(point.x, point.y);
      const popup = await opened;
      await expect(popup).toHaveURL(url);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
      const screenshot = testInfo.outputPath(`admin-terminal-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`admin-terminal-${width}`, { path: screenshot, contentType: 'image/png' });

      await page.keyboard.press('Escape');
      await expect(consoleView).toBeVisible();
      await back.click();
      await expect(page).toHaveURL(/#page-commands$/);
      expect(cancellations).toBe(0);
      finish?.();
      const command = page.getByRole('link', { name: './cao.sh add --repository octo/example', exact: true });
      await command.click();
      await expect(consoleView.getByRole('status')).toContainText('completed');
      await expect(subtitle).toContainText('completed');
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Repository staged.');
      await expect(back).toBeVisible();
      await expect(consoleView.getByRole('button', { name: 'Cancel command', exact: true })).toBeHidden();
      await back.click();

      await page.goto(`${preview.url}/#page-maintenance`);
      await page.getByRole('button', { name: 'Upgrade', exact: true }).first().click();
      const upgradeApproval = page.getByRole('dialog', { name: 'Approve Upgrade', exact: true });
      expect(runs).toBe(1);
      await expect(upgradeApproval.locator('.cli-action-dialog-body p code')).toHaveText('gh aw');
      await upgradeApproval.getByRole('button', { name: 'Upgrade', exact: true }).click();
      await expect.poll(() => runs).toBe(2);
      await expect(consoleView).toBeVisible();
      await expect(back).toBeVisible();
      await consoleView.getByRole('button', { name: 'Cancel command', exact: true }).click();
      await expect.poll(() => cancellations).toBe(1);
      await expect(consoleView.getByRole('status')).toContainText('canceled');
      await expect(consoleView).toBeVisible();
      await expect(page).toHaveURL(/#page-command\?command=\d+$/);
      await back.click();
      await expect(consoleView).not.toBeVisible();
      expect(runs).toBe(2);
    } finally {
      finish?.();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
