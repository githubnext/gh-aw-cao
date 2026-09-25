import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (!existsSync(filePath)) {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
      body: readFileSync(filePath)
    });
  });
  await page.goto('http://dashboard.test/');
});

test('rapid slider input evaluates only the latest complete scenario', async ({ page }) => {
  await page.evaluate(async () => {
    const { renderDashboardForm } = await import(`${location.origin}/src/components/dashboard-form.js`);
    const { compileDashboardViewPayloadQueries } = await import(`${location.origin}/src/data/queries/view-payload-compiler.js`);
    const { executeDashboardQueries } = await import(`${location.origin}/src/data/queries/declarative.js`);
    const pageDefinition = {
      form: {
        update: { strategy: 'debounce', 'delay-ms': 100 },
        fields: [{ id: 'multiplier', label: 'Multiplier', control: 'slider', default: 1, min: 0, max: 10, step: 1 }]
      },
      views: [{ id: 'simulation', data: { source: 'simulated-usage' } }]
    };
    const queries = [{
      name: 'simulated-usage',
      parameters: [{ name: 'multiplier', type: 'number' }],
      from: 'usage',
      compute: [{
        as: 'simulated-aic',
        function: 'product',
        args: [{ field: 'aic' }, { parameter: 'multiplier' }]
      }]
    }];
    const output = document.createElement('output');
    output.id = 'scenario-result';
    output.dataset.executions = '0';
    const form = renderDashboardForm(pageDefinition.form, undefined, (
      /** @type {Record<string, string|number|boolean>} */ formValues
    ) => {
      const payload = compileDashboardViewPayloadQueries(pageDefinition, 'simulator', {
        queries,
        queryContext: { formValues }
      });
      const result = executeDashboardQueries(payload.queries, {
        usage: {
          source: 'usage',
          rows: [{ aic: 4 }],
          metadata: {
            'source-id': 'usage',
            'source-kind': 'fixture',
            'as-of': '2026-09-24T00:00:00Z',
            'retrieved-at': '2026-09-24T00:00:00Z',
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }, payload.aliases);
      output.dataset.executions = String(Number(output.dataset.executions) + 1);
      output.value = String(result[payload.aliases[0]].rows[0]['simulated-aic']);
      output.textContent = output.value;
    });
    document.querySelector('#root')?.append(form, output);
  });

  const slider = page.getByRole('slider', { name: 'Multiplier' });
  await slider.evaluate((element) => {
    const input = /** @type {HTMLInputElement} */ (element);
    for (const value of ['2', '5', '8']) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await expect(page.locator('#scenario-result')).toHaveText('32');
  await expect(page.locator('#scenario-result')).toHaveAttribute('data-executions', '1');
});
