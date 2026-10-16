import { expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('view descriptions do not insert help controls at desktop and mobile widths', async ({ page }) => {
  await page.setContent(`
    <div class="layout-section" id="sections"></div>
    <script type="module">
      import { h } from 'http://dashboard.test/src/dom.js';
      import { primerStylesheet } from 'http://dashboard.test/src/styles.js';
      import { renderPageSection } from 'http://dashboard.test/src/components/view-chrome.js';
      import { renderDeclaredCliAction, setDeclaredCliActions } from 'http://dashboard.test/src/components/cli-actions.js';

      const style = document.createElement('style');
      style.textContent = primerStylesheet();
      document.head.append(style);
      setDeclaredCliActions([
        { id: 'update', label: 'Update all', icon: 'sync', command: 'gh aw update', placement: 'view' },
        { id: 'upgrade', label: 'Upgrade all', icon: 'download', command: 'gh aw upgrade', placement: 'view' }
      ]);
      for (const label of ['Update all', 'Upgrade all', 'Other action']) {
        const action = label === 'Other action'
          ? h('button', { type: 'button' }, label)
          : renderDeclaredCliAction(label === 'Update all' ? 'update' : 'upgrade');
        document.querySelector('#sections').append(renderPageSection(
          'repo',
          label,
          [h('header', { className: 'document-list-header' }, h('p', null, 'Campaigns'), action)],
          'h3',
          'Explanation of this action.'
        ));
      }
    </script>
  `);

  await expect(page.locator('#sections > .page-section')).toHaveCount(3);
  for (const width of [1200, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const section of await page.locator('#sections > .page-section').all()) {
      const action = section.locator('.document-list-header .cli-action-trigger, .document-list-header > button');
      await expect(section).toHaveAccessibleDescription('Explanation of this action.');
      await expect(section.locator('.tooltip-trigger, [role="tooltip"]')).toHaveCount(0);
      await expect(action).toBeVisible();
      await expect(section.getByRole('button')).toHaveCount(1);
    }
  }
});
