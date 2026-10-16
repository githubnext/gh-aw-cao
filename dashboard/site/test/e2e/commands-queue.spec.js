import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

for (const width of [1440, 390]) {
  test(`Commands retains detached work and reacts to completion at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    /** @type {string[]} */
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('requestfailed', (request) => browserErrors.push(`${new URL(request.url()).pathname.split('/').slice(2).join('/')}: ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) browserErrors.push(`${response.status()} ${new URL(response.url()).pathname.split('/').slice(2).join('/')}`);
    });
    let runs = 0;
    let cancellations = 0;
    /** @type {(() => void) | undefined} */
    let finish;
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', admin: true, port: 0,
      cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'),
      cliQueueAdmission: async () => ({ concurrency: 1 }),
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      lookupSelector: async () => [{ value: 'octo/example', label: 'octo/example' }],
      executeCliAction: async (/** @type {{ onOutput: (event: {stream: string, data: string}) => void, signal?: AbortSignal }} */ { onOutput, signal }) => {
        runs += 1;
        onOutput({ stream: 'stdout', data: 'Persistent command output\r\n' });
        await new Promise((resolve) => {
          finish = () => resolve(undefined);
          signal?.addEventListener('abort', () => { cancellations += 1; resolve(undefined); }, { once: true });
        });
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
      await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Add repository', exact: true }).click();
      const approval = page.getByRole('dialog', { name: 'Approve Add repository', exact: true });
      await approval.getByRole('searchbox', { name: 'Repository', exact: true }).fill('octo');
      await approval.getByRole('button', { name: 'octo/example', exact: true }).click();
      await approval.getByRole('button', { name: 'Add repository', exact: true }).click();
      await expect.poll(() => runs).toBe(1);
      await approval.getByRole('button', { name: 'Detach', exact: true }).click();
      await expect(approval).not.toBeVisible();
      expect(cancellations).toBe(0);

      if (width <= 700) await page.getByRole('button', { name: 'Select view', exact: true }).click();
      await page.getByRole('link', { name: 'Commands', exact: true }).last().click();
      const history = page.locator('[data-view-id="commands-history"]');
      await expect(page.locator('[data-view-id="commands-admission"]')).toHaveCount(0);
      await expect(history).toHaveAttribute('data-view-layout', 'full');
      await expect(history).toHaveAttribute('data-view-lazy-list', '');
      await expect(history.locator('.table-card-list')).toBeVisible();
      await expect(history.getByRole('table')).toHaveCount(0);
      await expect(history).toContainText('running');
      const command = history.getByRole('link', { name: /^\d+$/ }).first();
      const commandHref = await command.getAttribute('href');
      expect(commandHref).toContain('#page-command?command=');
      finish?.();
      await expect(history).toContainText('completed');
      expect(runs).toBe(1);
      const screenshot = testInfo.outputPath(`commands-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`commands-${width}`, { path: screenshot, contentType: 'image/png' });

      await command.click();
      const consoleDialog = page.getByRole('dialog', { name: 'Command console log', exact: true });
      await expect(consoleDialog).toBeVisible();
      const terminal = page.getByRole('region', { name: 'Read-only command terminal' });
      await expect(terminal).toBeVisible();
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Persistent command output');
      await page.reload();
      await expect(consoleDialog).toBeVisible();
      await expect(page.getByRole('region', { name: 'Read-only command terminal' })).toBeVisible();
      await consoleDialog.getByRole('button', { name: 'Reconnect output', exact: true }).click();
      await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('Persistent command output');
      const terminalScreenshot = testInfo.outputPath(`commands-console-${width}.png`);
      await page.screenshot({ path: terminalScreenshot, fullPage: true });
      await testInfo.attach(`commands-console-${width}`, { path: terminalScreenshot, contentType: 'image/png' });
      await consoleDialog.getByRole('button', { name: 'Close command console', exact: true }).click();
      await expect(page).toHaveURL(/#page-commands$/);
      await expect(consoleDialog).not.toBeVisible();
      await expect(history).toContainText('completed');
      await history.getByRole('link', { name: /^\d+$/ }).first().click();
      await expect(consoleDialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/#page-commands$/);
      expect(runs).toBe(1);
      expect(cancellations).toBe(0);
    } catch (error) {
      await testInfo.attach('commands-failure-content', {
        body: `${browserErrors.join('\n')}\n${await page.locator('main').innerText().catch(() => 'Page unavailable.')}`,
        contentType: 'text/plain'
      });
      throw error;
    } finally {
      finish?.();
      await page.goto('about:blank').catch(() => {});
      await preview.close();
    }
  });
}
