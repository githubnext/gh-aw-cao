import { authoritativeDashboard, buildPresenterModuleUrl, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import { getPrimerStyles } from '../../src/styles.js';

registerSmokeRoutes();

test('a loading chart has no prompt action until its own data arrives', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const loadPageSources = (_pageId, options) => new Promise((resolve) => {
        window.publishChart = () => options.onUpdate({
          runs: {
            source: 'runs', rows: [{ workflow: 'daily', count: 3 }],
            metadata: {
              'source-id': 'runs', 'source-kind': 'fixture',
              'as-of': '', 'retrieved-at': '',
              availability: 'available', completeness: 'complete', freshness: 'fresh'
            }
          }
        });
        window.finishLoading = () => resolve({});
      });
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'loading-prompts', title: 'Loading prompts',
            pages: [{
              id: 'overview', kind: 'custom', title: 'Overview',
              views: [{
                id: 'runs-chart', title: 'Runs chart', prompt: 'always',
                mark: 'chart', chart: 'bar', data: { source: 'runs' },
                encoding: {
                  x: { field: 'workflow', type: 'nominal' },
                  y: { field: 'count', type: 'quantitative' }
                }
              }]
            }]
          }
        },
        sources: {},
        loadPageSources
      }));
    </script>
  `);
  await page.addStyleTag({ content: getPrimerStyles() });
  const view = page.locator('[data-view-id="runs-chart"]');
  const action = view.getByRole('button', { name: 'Propose fix: Runs chart' });
  await expect(view).toHaveAttribute('aria-busy', 'true');
  await expect(view.locator('.dashboard-view-skeleton')).toBeVisible();
  await expect(view.locator('.table-intent-button')).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, 'publishChart')());
  await expect(action).toBeVisible();
  await expect(view.locator('.dashboard-view-skeleton')).toHaveCount(0);
  await action.click();
  await expect(view.locator('.table-intent-preview')).toContainText('"workflow": "daily"');
  await page.evaluate(() => Reflect.get(window, 'finishLoading')());
});

test('an independently loading element hides its prompt until all busy widgets settle', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      import { configureSourceLoader } from 'http://dashboard.test/src/source-store.js';
      const resolutions = new Map();
      configureSourceLoader((name) => new Promise((resolve) => resolutions.set(name, resolve)));
      window.resolveHeaderSource = (name) => resolutions.get(name)({
        source: name,
        rows: name === 'overview-header-presentation' ? [{ heading: 'Campaign health', summary: 'Ready' }] : [],
        metadata: {
          'source-id': name, 'source-kind': 'fixture', 'as-of': '', 'retrieved-at': '',
          availability: name === 'overview-header-presentation' ? 'available' : 'empty',
          completeness: 'complete', freshness: 'fresh'
        }
      });
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'loading-element', title: 'Loading element',
            pages: [{
              id: 'overview', kind: 'custom', title: 'Overview',
              views: [{
                id: 'header', title: 'Campaign header', prompt: 'always',
                mark: 'element', element: 'factory-header',
                data: { sources: ['overview-header-presentation', 'overview-rhythm'] }
              }]
            }]
          }
        },
        sources: {}
      }));
    </script>
  `);
  await page.addStyleTag({ content: getPrimerStyles() });
  const view = page.locator('[data-view-id="header"]');
  const action = view.locator('.table-intent-button');
  await expect(view.locator('#agent-factory-heading')).toHaveAttribute('aria-busy', 'true');
  await expect(action).toBeHidden();
  await expect(view.getByRole('button', { name: 'Create prompt for Campaign header' })).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, 'resolveHeaderSource')('overview-header-presentation'));
  await expect(view.locator('#agent-factory-heading')).toHaveText('Campaign health');
  await expect(action).toBeHidden();
  await page.evaluate(() => Reflect.get(window, 'resolveHeaderSource')('overview-rhythm'));
  await expect(action).toBeVisible();
});

test('a chart with composed semantics offers a prompt preview and returns focus', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(buildPresenterModuleUrl())};
      const metadata = {
        'source-id': 'cost-by-campaign', 'source-kind': 'fixture',
        'as-of': '2026-09-01T00:00:00Z', 'retrieved-at': '2026-09-01T00:00:00Z',
        availability: 'available', completeness: 'complete', freshness: 'fresh'
      };
      document.querySelector('#root').append(renderDashboard({
        document: ${JSON.stringify(authoritativeDashboard)},
        sources: {
          'cost-by-campaign': {
            source: 'cost-by-campaign',
            rows: [{ 'campaign-name': 'Campaign A', aic: 12 }],
            metadata
          }
        }
      }));
    </script>
  `);
  await page.addStyleTag({ content: getPrimerStyles() });
  await page.evaluate(() => { window.location.hash = '#page-cost'; });
  const action = page.locator('[data-view-id="cost-by-campaign"] .table-intent-button');
  await expect(action).toBeVisible();
  const titleRow = page.locator('[data-view-id="cost-by-campaign"] .chart-prompt-heading');
  await expect(titleRow.locator('h3, h4')).toBeVisible();
  await expect(action.locator('.octicon')).toBeVisible();
  await expect(action).toHaveAttribute('aria-label', /Propose fix: /);
  await expect(action.locator('span')).toBeHidden();
  const titleBox = await titleRow.locator('h3, h4').boundingBox();
  const buttonBox = await action.boundingBox();
  if (!titleBox || !buttonBox) throw new Error('Chart title and prompt button must be visible.');
  expect(buttonBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(buttonBox.y).toBeLessThan(titleBox.y + titleBox.height);
  await action.click();
  const dialog = page.locator('[data-view-id="cost-by-campaign"] .table-intent-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.table-intent-preview')).toContainText('Subject:');
  await expect(dialog.locator('.table-intent-preview')).toContainText('Named CAO query IDs:');
  await expect(dialog.locator('.table-intent-preview')).toContainText('Any unusual campaign cost is explained');
  await expect(dialog.locator('.table-intent-preview')).toContainText('/analyze-cao');
  await expect(dialog.locator('.table-intent-preview')).toContainText('This is a preview of the data. Requery for full data.');
  await expect(dialog.locator('.table-intent-preview')).toContainText('Create a PR with the changes.');
  await dialog.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(action).toBeFocused();
});

test('an open shared prompt preview tracks reactive evidence until it closes', async ({ page }) => {
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderPromptPreviewAction } from ${JSON.stringify('http://dashboard.test/src/components/data-view.js')};
      import { state } from ${JSON.stringify('http://dashboard.test/src/reactive.js')};
      const evidence = state('first observation');
      const action = renderPromptPreviewAction('Inspect evidence', evidence.get, undefined, 'comment', 'semantic-prompt');
      window.refreshEvidence = () => evidence.set('updated observation');
      document.querySelector('#root').append(action);
    </script>
  `);
  await page.getByRole('button', { name: 'Inspect evidence' }).click();
  const preview = page.locator('.table-intent-preview');
  await expect(preview).toHaveText('first observation');
  await page.evaluate(() => Reflect.get(window, 'refreshEvidence')());
  await expect(preview).toHaveText('updated observation');
  await page.getByRole('button', { name: 'Close prompt preview' }).click();
  await expect(page.getByRole('button', { name: 'Inspect evidence' })).toBeFocused();
});
