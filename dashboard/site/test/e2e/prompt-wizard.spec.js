import { authoritativeDashboard, buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import { getPrimerStyles } from '../../src/styles.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { startCanvasServer } = await import(new URL('../../../canvas-server.mjs', import.meta.url).href);

registerSmokeRoutes();

for (const width of [390, 1280]) {
  test(`JSON wizard supports Campaign design, keyboard navigation and prompt copy at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const wizardPage = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'wizard');
    await page.evaluate(() => { window.location.hash = 'page-wizard'; });
    await page.setContent(`
      <div id="root"></div>
      <script type="module">
        import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
        document.querySelector('#root').append(renderDashboard({
          document: { languageVersion: '0.1.0', dashboard: {
            id: 'wizard-browser-contract', title: 'Workflow design',
            pages: [${JSON.stringify(wizardPage)}],
            navigation: [{ pages: ['wizard'] }]
          } }, sources: {}
        }));
      </script>
    `);
    await page.addStyleTag({ content: getPrimerStyles() });
    const root = page.locator('.prompt-wizard');
    await expect(root).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeHidden();
    await expect(page.getByLabel('What should the agent do? (optional)')).toBeHidden();
    await expect(page.getByLabel('Workflow or campaign name (required)')).toHaveCount(0);
    const choices = page.locator('.prompt-wizard-cards .entity-card-list-marketplace');
    await expect(choices.locator('.prompt-wizard-card')).toHaveCount(35);
    await page.getByRole('button', { name: 'Issue Triage', exact: true }).click();
    await expect(page.getByLabel('What do you want to generate? (required)')).toBeFocused();
    await expect(choices).toBeHidden();
    await page.getByLabel('What do you want to generate? (required)').selectOption('campaign');
    await page.getByLabel('What should the agent do? (optional)').fill('Label new issues and leave uncertain reports for human review.');
    await page.getByLabel('Intent and acceptance criteria (optional)').fill('Never close issues. Use the existing label taxonomy.');
    await page.getByLabel('Intent and acceptance criteria (optional)').press('Tab');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByLabel('Per-run scope and limits (required)')).toBeFocused();
    await page.getByLabel('Per-run scope and limits (required)').fill('One dispatched target, one issue per worker.');
    await page.getByLabel('Campaign target repositories (required)').fill('acme/one\nacme/two');
    await page.getByRole('checkbox', { name: 'add comment', exact: false }).check();
    await page.getByRole('button', { name: 'Review design', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review your design', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Generate prompt', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Generate prompt prompt preview' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.table-intent-preview')).toContainText('acme/one');
    await expect(dialog.locator('.table-intent-preview')).toContainText('default to review mode');
    await expect(dialog.locator('.table-intent-preview')).toContainText('"recommended_triggers"');
    await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate prompt', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Campaign target repositories (required)')).toHaveValue('acme/one\nacme/two');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const selected = page.getByRole('button', { name: 'Issue Triage', exact: true });
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await expect(selected).toBeFocused();
    await selected.press('Enter');
    await expect(page.getByLabel('What do you want to generate? (required)')).toBeFocused();
    expect(await root.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test.describe('populated dashboard wizard', () => {
  for (const width of [390, 594, 1280]) {
    test(`full-site workflow prompt button copies without command execution at ${width}px`, async ({ page }, testInfo) => {
      /** @type {Array<{ id: string, command: string, input?: string }>} */
      const commands = [];
      const server = await startCanvasServer({
        workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
        repository: 'acme/control', port: 0,
        approveCliAction: async () => true,
        cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'),
        cliQueueAdmission: async () => ({ concurrency: 1 }),
        output: () => {}, requestOutput: () => {}, traceOutput: () => {},
        executeCliAction: async (/** @type {{ id: string, command: string, input?: string }} */ request) => {
          commands.push({ id: request.id, command: request.command, input: request.input });
          return { ok: true, exitCode: 0 };
        },
        downloadData: async (/** @type {string} */ destination) => {
          await mkdir(destination, { recursive: true });
          const metadata = { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' };
          await writeFile(join(destination, 'sources.json'), JSON.stringify({
            repositories: { metadata, rows: [{ organization: 'acme', repository: 'control' }] },
            workflows: { metadata, rows: [{ organization: 'acme', repository: 'control', workflow: 'demo.md', 'workflow-name': 'Demo' }] }
          }));
        }
      });
      try {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async (/** @type {string} */ text) => { Reflect.set(window, 'copiedWizardPrompt', text); } }
          });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${server.url}/#page-wizard`);
        await expect(page.locator('.prompt-wizard')).toBeVisible();
        await expect(page.locator('.first-load-overlay')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Custom automation', exact: true })).toBeVisible();
        const cardContent = page.locator('.prompt-wizard-card .issue-list-card-content').first();
        const description = page.locator('.prompt-wizard-card .issue-list-card-subtitle').first();
        await expect(description).toHaveText('Design an automation from your own requirements.');
        expect(await cardContent.evaluate((element) => getComputedStyle(element).gridColumnStart)).toBe('1');
        expect(await cardContent.evaluate((element) => getComputedStyle(element).gridRowStart)).toBe('2');
        await expect(page.getByText('Use this type', { exact: true })).toHaveCount(0);
        const typeScreenshot = testInfo.outputPath(`workflow-wizard-types-${width}.png`);
        await page.screenshot({ path: typeScreenshot, fullPage: false });
        await testInfo.attach(`Workflow type marketplace (${width}px)`, { path: typeScreenshot, contentType: 'image/png' });
        await page.getByRole('button', { name: 'Issue Triage', exact: true }).click();
        const purpose = page.getByLabel('What should the agent do? (optional)');
        const acceptance = page.getByLabel('Intent and acceptance criteria (optional)');
        await expect(purpose).not.toHaveAttribute('required');
        await expect(acceptance).not.toHaveAttribute('required');
        await expect(purpose).toHaveValue('');
        await expect(acceptance).toHaveValue('');
        const goalScreenshot = testInfo.outputPath(`workflow-wizard-optional-${width}.png`);
        await page.screenshot({ path: goalScreenshot, fullPage: false });
        await testInfo.attach(`Optional scenario refinements (${width}px)`, { path: goalScreenshot, contentType: 'image/png' });
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(page.getByLabel('Campaign target repositories (required)')).toBeHidden();
        await page.getByLabel('Per-run scope and limits (required)').fill('Only the triggering issue.');
        await page.getByRole('button', { name: 'Review design', exact: true }).click();
        await page.getByRole('button', { name: 'Generate prompt', exact: true }).click();
        expect(commands).toEqual([]);
        await expect(page.getByRole('button', { name: 'Start agent task', exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, 'copiedWizardPrompt'))).toBeUndefined();
        const screenshot = testInfo.outputPath(`workflow-wizard-prompt-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach(`Workflow wizard prompt (${width}px)`, { path: screenshot, contentType: 'image/png' });
        await page.getByRole('dialog').getByRole('button', { name: 'Copy prompt', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText('Prompt copied.');
        expect(await page.evaluate(() => Reflect.get(window, 'copiedWizardPrompt'))).toContain('Classify and label new issues');
        expect(await page.evaluate(() => Reflect.get(window, 'copiedWizardPrompt'))).toContain('infer them from the selected scenario');
        expect(await page.evaluate(() => Reflect.get(window, 'copiedWizardPrompt'))).toContain('Infer a concise title and kebab-case workflow file name');
        expect(commands).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await page.goto('about:blank');
        await server.close();
      }
    });
  }
});
