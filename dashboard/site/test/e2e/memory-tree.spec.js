import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('Memory tree keyboard navigation follows expanded folders', async ({ context, page }) => {
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
              { path: 'notes/first.md', oid: 'b'.repeat(40), size: 7 },
              { path: 'notes/second.md', oid: 'c'.repeat(40), size: 11 },
            ],
            omitted: {},
          }],
        }),
      });
      return;
    }
    if (path === '/memory/ambient-context/notes/first.md') {
      await route.fulfill({ contentType: 'text/plain', body: '# First' });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderAllCampaignMemory } from '/src/components/campaign-memory.js';
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
  const tree = page.getByRole('tree', { name: 'Campaign memory files' });
  const campaign = tree.getByRole('treeitem', { name: 'Ambient Context' });
  const directory = tree.getByRole('treeitem', { name: 'notes' });
  const first = tree.getByRole('treeitem', { name: /first\.md/ });
  await expect(campaign).toHaveAttribute('tabindex', '0');
  await campaign.focus();
  await page.keyboard.press('ArrowRight');
  await expect(campaign).toHaveAttribute('aria-expanded', 'true');
  await expect(directory).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(directory).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cao-memory-file-content pre')).toHaveText('# First');
  await expect(first).toHaveAttribute('aria-current', 'true');
});
