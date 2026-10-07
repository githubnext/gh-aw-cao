import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

const jsonlContent = Array.from({ length: 30 }, (_, index) => JSON.stringify({
  id: 30 - index,
  label: `record-${String(index).padStart(2, '0')}`,
  detail: { description: 'A-long-nested-memory-value-'.repeat(8) },
})).join('\n');

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/memory/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/memory/manifest.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          campaigns: [{
            campaign: 'ambient-context',
            branch: 'memory/ambient-context',
            commit: 'a'.repeat(40),
            files: [
              { path: 'notes/deep/first.md', oid: 'b'.repeat(40), size: 7 },
              { path: 'notes/deep/second.md', oid: 'c'.repeat(40), size: 11 },
              { path: 'notes/deep/a-very-long-memory-file-name-that-must-truncate-instead-of-wrapping.json', oid: 'd'.repeat(40), size: 1024 },
              { path: 'notes/deep/settings.yaml', oid: 'e'.repeat(40), size: 8 },
              { path: 'notes/deep/plain.txt', oid: 'f'.repeat(40), size: 9 },
              { path: 'records.jsonl', oid: '1'.repeat(40), size: jsonlContent.length },
            ],
            omitted: {},
          }],
        }),
      });
      return;
    }
    if (path === '/memory/ambient-context/notes/deep/first.md') {
      await route.fulfill({ contentType: 'text/plain', body: '# First' });
      return;
    }
    if (path === '/memory/ambient-context/records.jsonl') {
      await route.fulfill({ contentType: 'text/plain', body: jsonlContent });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  await page.setContent(`
    <div id="root" class="dashboard-root" data-theme="dark"></div>
    <script type="module">
      import { renderAllCampaignMemory } from '/src/components/campaign-memory.js';
      import { primerStylesheet } from '/src/styles.js';
      const style = document.createElement('style');
      style.textContent = primerStylesheet();
      document.head.append(style);
      document.querySelector('#root').append(renderAllCampaignMemory({
        pageId: 'memory',
        title: 'Memory',
        sourceNames: ['campaign-memory-campaigns'],
        sources: {
          'campaign-memory-campaigns': {
            source: 'campaign-memory-campaigns',
            rows: [{ campaign: 'ambient-context', 'campaign-name': 'Ambient Context' }],
            metadata: {
              'source-id': 'memory-test',
              'source-kind': 'fixture',
              'as-of': '2026-09-26T00:00:00Z',
              'retrieved-at': '2026-09-26T00:00:00Z',
              completeness: 'complete',
              freshness: 'fresh',
              availability: 'available'
            }
          }
        },
        contextDetails: [],
        headingTag: 'h3'
      }));
    </script>
  `);
});

for (const width of [1280, 390]) {
  test(`JSONL memory reuses table controls and accessible tabs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const tree = page.getByRole('tree', { name: 'Campaign memory files' });
    await tree.getByRole('treeitem', { name: 'Ambient Context' }).click();
    await page.evaluate(() => {
      Reflect.set(window, 'memoryMainParseCount', 0);
      const parse = JSON.parse;
      JSON.parse = (text, reviver) => {
        if (text.includes('record-07')) {
          Reflect.set(window, 'memoryMainParseCount', Reflect.get(window, 'memoryMainParseCount') + 1);
        }
        return parse(text, reviver);
      };
    });
    await tree.getByRole('treeitem', { name: /records\.jsonl/ }).click();
    const content = page.locator('.cao-memory-file-content');
    const raw = content.getByRole('tab', { name: 'Raw', exact: true });
    const table = content.getByRole('tab', { name: 'Table', exact: true });
    await expect(raw).toHaveAttribute('aria-selected', 'true');
    await raw.focus();
    await page.keyboard.press('ArrowRight');
    await expect(table).toBeFocused();
    await expect(table).toHaveAttribute('aria-selected', 'true');
    await expect(content.locator('.table-filter-result')).toHaveText('Showing 25 of 30 records');
    await expect(content.locator('thead th')).toHaveText(['Line', 'id', 'label', 'detail']);
    await content.getByRole('button', { name: /^id / }).click();
    await expect(content.locator('tbody tr:visible').first().locator('td').nth(1)).toHaveText('1');
    const filter = content.getByRole('searchbox', { name: 'Filter JSONL records' });
    await filter.fill('record-07');
    await expect(content.locator('.table-filter-result')).toHaveText('Showing 1 of 1 record');
    await expect(content.locator('tbody tr:visible')).toContainText('record-07');
    await raw.click();
    await expect(content.locator('pre')).toBeVisible();
    await table.click();
    await expect(filter).toHaveValue('record-07');
    await expect.poll(() => content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => content.locator('.table-filter').evaluate((element) =>
      element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'memoryMainParseCount'))).toBe(0);
  });
}

test('Memory tree keyboard navigation follows expanded folders', async ({ page }) => {
  const tree = page.getByRole('tree', { name: 'Campaign memory files' });
  const campaign = tree.getByRole('treeitem', { name: 'Ambient Context' });
  const directory = tree.getByRole('treeitem', { name: 'notes', exact: true });
  const nestedDirectory = tree.getByRole('treeitem', { name: 'deep', exact: true });
  const first = tree.getByRole('treeitem', { name: /first\.md/ });
  await expect(campaign).toHaveAttribute('tabindex', '0');
  await campaign.focus();
  await page.keyboard.press('ArrowRight');
  await expect(campaign).toHaveAttribute('aria-expanded', 'true');
  await expect(directory).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(directory).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(nestedDirectory).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cao-memory-file-content pre')).toHaveText('# First');
  await expect(first).toHaveAttribute('aria-current', 'true');
});

for (const width of [1280, 390]) {
  for (const theme of ['dark', 'light']) {
    test(`Memory tree has aligned, single-line rows at ${width}px in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#root').evaluate((root, themeName) => {
        root.dataset.theme = themeName;
      }, theme);
      const tree = page.getByRole('tree', { name: 'Campaign memory files' });
      const campaign = tree.getByRole('treeitem', { name: 'Ambient Context' });
      const directory = tree.getByRole('treeitem', { name: 'notes', exact: true });
      const nestedDirectory = tree.getByRole('treeitem', { name: 'deep', exact: true });
      await campaign.click();
      await expect(directory).toBeVisible();

      const chevron = campaign.locator('.memory-tree-chevron');
      await expect(chevron).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
      await expect(campaign).toHaveCSS('list-style-type', 'none');
      const positions = await Promise.all([campaign, directory, nestedDirectory].map(async (row) => {
        const bounds = await row.locator('.memory-tree-chevron').boundingBox();
        expect(bounds).not.toBeNull();
        return bounds?.x ?? 0;
      }));
      expect(positions[1] - positions[0]).toBe(16);
      expect(positions[2] - positions[1]).toBe(16);

      const longFile = tree.getByRole('treeitem', { name: /a-very-long-memory-file-name/ });
      const filename = longFile.locator('.memory-file-name');
      await expect(filename).toHaveCSS('white-space', 'nowrap');
      await expect(filename).toHaveCSS('text-overflow', 'ellipsis');
      await expect.poll(() => filename.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await expect(longFile).toHaveAttribute('title', 'notes/deep/a-very-long-memory-file-name-that-must-truncate-instead-of-wrapping.json (1.0 KiB)');
      await expect(longFile.locator('.octicon-file-code')).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: /first\.md/ }).locator('.octicon-markdown')).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: /settings\.yaml/ }).locator('.octicon-file-code')).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: /plain\.txt/ }).locator('.octicon-file')).toBeVisible();
      const fileIconBounds = await longFile.locator('.octicon-file-code').boundingBox();
      expect(fileIconBounds?.x).toBe(positions[2] + 16);
      await expect.poll(() => tree.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

      await nestedDirectory.click();
      await expect(nestedDirectory).toHaveAttribute('aria-expanded', 'false');
      await expect(nestedDirectory.locator('.memory-tree-chevron')).toHaveCSS('transform', 'none');
      await expect(longFile).toBeHidden();
      await nestedDirectory.click();
      await expect(longFile).toBeVisible();
      await campaign.click();
      await expect(chevron).toHaveCSS('transform', 'none');
      await expect(directory).toBeHidden();
    });
  }
}
