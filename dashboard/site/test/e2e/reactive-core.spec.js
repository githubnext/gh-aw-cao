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

test('reactive shadow-tree updates preserve focused keyed nodes in browser', async ({ page }) => {
  const domSource = readFileSync(new URL('../../src/dom.js', import.meta.url), 'utf8');
  const reconcilerSource = readFileSync(new URL('../../src/dom-reconciler.js', import.meta.url), 'utf8')
    .replace("'./dom.js'", JSON.stringify(`data:text/javascript;charset=utf-8,${encodeURIComponent(domSource)}`));
  const reconcilerModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(reconcilerSource)}`;
  const reactiveSource = readFileSync(new URL('../../src/reactive.js', import.meta.url), 'utf8')
    .replace("'./dom-reconciler.js'", JSON.stringify(reconcilerModuleUrl));
  const reactiveModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(reactiveSource)}`;
  const domModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(domSource)}`;

  await page.setContent(`
    <main id="app"></main>
    <script type="module">
      import { h } from ${JSON.stringify(domModuleUrl)};
      import { render, state } from ${JSON.stringify(reactiveModuleUrl)};
      const app = document.querySelector('#app');
      const items = state([
        { id: 'run-1', label: 'Run 1' },
        { id: 'run-2', label: 'Run 2' }
      ]);
      render(app, () => items.get().map((item) =>
        h('label', { 'data-key': item.id }, item.label, h('input', { 'aria-label': item.label }))
      ));
      window.reorder = () => items.set([
        { id: 'run-2', label: 'Run 2 updated' },
        { id: 'run-1', label: 'Run 1' }
      ]);
    </script>
  `);

  const input = page.getByRole('textbox', { name: 'Run 1' });
  await input.fill('local edit');
  await page.evaluate(() => /** @type {{ reorder: () => void }} */ (/** @type {unknown} */ (window)).reorder());

  await expect(page.locator('#app > label')).toHaveText(['Run 2 updated', 'Run 1']);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('local edit');
});
