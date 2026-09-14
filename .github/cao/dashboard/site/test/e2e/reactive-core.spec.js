import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('DLS-CONF-004 reactive DOM nodes render stable keyed output in browser', async ({ page }) => {
  const domSource = readFileSync(new URL('../../src/dom.js', import.meta.url), 'utf8');
  const domModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(domSource)}`;

  await page.setContent(`
    <main id="app"></main>
    <script type="module">
      import { h, keyed } from ${JSON.stringify(domModuleUrl)};
      const app = document.querySelector('#app');
      const items = [
        { id: 'run-2', label: 'Run 2' },
        { id: 'run-1', label: 'Run 1' }
      ];
      app.append(h('section', null,
        h('h1', null, 'Reactive core'),
        h('div', { id: 'list' }, keyed(items, (item) => h('a', { href: '#' + item.id }, item.label), (item) => item.id))
      ));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Reactive core' })).toBeVisible();
  await expect(page.locator('#list a')).toHaveText(['Run 2', 'Run 1']);
});
