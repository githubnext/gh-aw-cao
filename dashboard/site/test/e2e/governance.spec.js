import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
const { startDashboardServer } = await import(new URL('../../../local-server.mjs', import.meta.url).href);

for (const width of [1440, 390]) {
  test(`Governance loads, previews and approves scoped defaults at ${width}px`, async ({ page }, testInfo) => {
    /** @type {Array<{ command: string, input?: string }>} */
    const executions = [];
    const current = 'default_max_turns: "20"\ndefault_model_copilot: null\ndefault_timeout_minutes: "15"\n';
    const edited = current.replace('"20"', '"30"');
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', admin: true, port: 0,
      cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'), cliQueueAdmission: async () => ({ concurrency: 1 }),
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      executeCliAction: async (/** @type {{ command: string, input?: string, onOutput: (event: { stream: 'stdout'|'stderr', data: string }) => void }} */ { command, input, onOutput }) => {
        executions.push({ command, input });
        if (command.includes('env get')) {
          onOutput({ stream: 'stderr', data: 'Saved defaults.\n' });
          onOutput({ stream: 'stdout', data: current });
        } else {
          onOutput({ stream: 'stdout', data: command.includes('--dry-run')
            ? 'default_max_turns SET 30\ndefault_model_copilot DELETE\nDry-run mode enabled; no variables were changed.\n'
            : 'Updated defaults.\n' });
        }
        return { ok: true };
      },
      downloadData: async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'sources.json'), JSON.stringify({
          repositories: {
            metadata: { 'as-of': new Date().toISOString(), availability: 'available', completeness: 'complete', freshness: 'fresh' },
            rows: [{ organization: 'acme', repository: 'control' }]
          }
        }));
      }
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${preview.url}/#page-governance`);
      const editor = page.getByRole('region', { name: 'Compiler defaults editor' });
      await expect(editor).toBeVisible();
      await expect(page.locator('[data-nav-section="Maintenance"]').getByRole('link', { name: 'Governance', exact: true, includeHidden: true }))
        .toHaveAttribute('href', '#page-governance');
      await editor.getByRole('textbox', { name: 'Target', exact: true }).fill('acme');
      await editor.getByRole('button', { name: 'Load defaults', exact: true }).click();
      const yaml = editor.getByRole('textbox', { name: 'Compiler defaults YAML' });
      await expect(yaml).toHaveValue(current);
      await yaml.fill(edited);
      await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
      const apply = editor.getByRole('button', { name: 'Review and apply', exact: true });
      await expect(apply).toBeEnabled();
      await expect(editor).toContainText('no variables were changed');
      expect(executions).toEqual([
        { command: 'gh aw env get cao-governance.yml --scope org --org acme', input: undefined },
        { command: 'gh aw env update cao-governance.yml --scope org --org acme --visibility all --yes --dry-run', input: edited }
      ]);
      await page.screenshot({ path: testInfo.outputPath(`governance-${width}.png`), fullPage: true });
      await testInfo.attach(`governance-${width}`, { path: testInfo.outputPath(`governance-${width}.png`), contentType: 'image/png' });
      await apply.click();
      const dialog = page.getByRole('dialog', { name: 'Approve compiler defaults' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('outside CAO');
      await expect(dialog.locator('pre')).toContainText(edited);
      expect(executions).toHaveLength(2);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(apply).toBeFocused();
      await apply.click();
      await dialog.getByRole('button', { name: 'Apply defaults', exact: true }).click();
      await expect(editor).toContainText('Reload to verify the saved values');
      expect(executions[2]).toEqual({
        command: 'gh aw env update cao-governance.yml --scope org --org acme --visibility all --yes', input: edited
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await editor.getByRole('combobox', { name: 'Variable scope' }).selectOption('ent');
      await expect(yaml).toHaveValue('');
      await expect(apply).toBeDisabled();
    } finally {
      await preview.close();
    }
  });
}

for (const canvas of [false, true]) {
  test(`Governance is hidden without --admin${canvas ? ' in canvas mode' : ''}`, async ({ page }, testInfo) => {
    const preview = await startDashboardServer({
      workingDirectory: fileURLToPath(new URL('../../../../', import.meta.url)),
      repository: 'acme/control', canvas, port: 0, dataBackend: 'indexeddb',
      cliQueuePath: testInfo.outputPath('.cao', 'cli-actions.sqlite'),
      cliQueueAdmission: async () => ({ concurrency: 1 }),
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      approveCliAction: async () => false,
      executeCliAction: async () => { throw new Error('Hidden Governance must not execute commands.'); },
      downloadData: async (/** @type {string} */ destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'sources.json'), '{}');
      }
    });
    try {
      await page.goto(`${preview.url}/#page-governance`);
      await expect(page.locator('#page-title')).toHaveText('Overview');
      await expect(page.locator('a[href="#page-governance"]')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Compiler defaults editor' })).toHaveCount(0);
      await page.goto(`${preview.url}/?local-preview=admin#page-governance`);
      await expect(page.locator('#page-title')).toHaveText('Overview');
      await expect(page.locator('a[href="#page-governance"]')).toHaveCount(0);
    } finally {
      await preview.close();
    }
  });
}
