import { buildPresenterModuleUrl, builtInPage, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';

registerSmokeRoutes();

test('DLS-SAFE-004 runtime links with embedded credentials, ftp schemes, and blank labels are not exposed in browser output', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();

  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};

      const dashboardDocument = {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'credential-link-dashboard',
          title: 'Credential Link Dashboard',
          pages: [{
            id: 'credential-links',
            kind: 'custom',
            title: 'Credential Links',
            views: [
              {
                id: 'credential-links-table',
                title: 'Credential Links Table',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              },
              {
                id: 'credential-links-metric',
                title: 'Credential Links Metric',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: {
                  value: { field: 'run', type: 'nominal', aggregate: 'count' },
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      };

      const sources = {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-link': { href: 'https://user:secret@example.com/runs/1', label: 'Credentialed Run' } },
            { run: '2', 'run-link': { href: 'ftp://example.com/runs/2', label: 'FTP Run' } },
            { run: '3', 'run-link': { href: 'https://example.com/runs/3', label: '   ' } },
            { run: '4', 'run-link': { href: 'https://example.com/runs/4', label: 'Run 4' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };

      document.querySelector('#root').append(renderDashboard({ document: dashboardDocument, sources }));
    </script>
  `);

  await expect(page.getByRole('heading', { name: 'Credential Links', level: 1 })).toBeVisible();
  await expect(page.locator('.custom-table a')).toHaveText('4');
  await expect(page.locator('.metric-link a')).toHaveText('Run 4');
  await expect(page.locator('a[href*="user:secret@"]').first()).toHaveCount(0);
  await expect(page.locator('a[href^="ftp:"]').first()).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Credentialed Run');
  await expect(page.locator('body')).not.toContainText('FTP Run');
});

test('desktop navigation collapses to an icon rail and expands back to text', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 1200, height: 800 });
  const dashboardContent = `
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'sidebar-toggle-dashboard',
            title: 'Sidebar Toggle',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `;
  await page.setContent(dashboardContent);

  const toggle = page.getByRole('button', { name: 'Collapse navigation' });
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
  await toggle.click();

  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '64px');
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.nav-label').first()).toBeHidden();
  await expect(page.locator('.sidebar-brand')).toBeHidden();

  await page.reload();
  await page.setContent(dashboardContent);
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);

  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.nav-label').first()).toBeVisible();
  await expect(page.locator('.sidebar-brand')).toBeVisible();

  await page.reload();
  await page.setContent(dashboardContent);
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/);

  await expect(page.locator('.org-sidebar')).toHaveCSS('width', '200px');
});

test('phone navigation keeps all views in the full-label menu without horizontal scrolling', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-navigation-dashboard',
            title: 'Phone Navigation',
            repository: 'githubnext/gh-aw-cao',
            pages: [
              { id: 'overview', kind: 'custom', title: 'Overview', icon: 'home', views: [] },
              { id: 'runs', kind: 'custom', title: 'Runs', icon: 'play', views: [] },
              { id: 'security', kind: 'custom', title: 'Security', icon: 'shield', views: [] },
              { id: 'value', kind: 'custom', title: 'Value', icon: 'graph', views: [] },
              { id: 'cost', kind: 'custom', title: 'Cost & efficiency', icon: 'meter', views: [] },
              { id: 'campaigns', kind: 'custom', title: 'Campaigns', icon: 'goal', views: [] }
            ],
            navigation: [
              { label: 'Main', pages: ['overview', 'runs', 'security'] },
              { label: 'Investigate', pages: ['value', 'cost', 'campaigns'] }
            ]
          }
        },
        sources: {}
      }));
    </script>
  `);

  const historyBack = page.getByRole('button', { name: 'Go back' });
  await expect(historyBack).toBeHidden();
  const mobileBrandName = page.locator('.mobile-page-header .mobile-brand-name');
  await expect(mobileBrandName).toBeVisible();
  await expect(mobileBrandName).toHaveText('gh-aw-cao');
  expect(await page.evaluate(() => {
    const title = document.querySelector('.mobile-page-header #page-title');
    const brand = document.querySelector('.mobile-page-header .mobile-brand-name');
    if (!title || !brand) return false;
    return brand.getBoundingClientRect().top >= title.getBoundingClientRect().bottom;
  })).toBe(true);
  await expect(page.locator('.primary-nav')).toBeHidden();

  const viewMenuButton = page.getByRole('button', { name: 'Select view' });
  await expect(viewMenuButton).toHaveCSS('border-radius', '50%');
  await expect(viewMenuButton).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await viewMenuButton.click();
  const menu = page.locator('.mobile-nav-menu-list');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mobile-nav-item')).toHaveCount(6);
  await expect(menu.getByText('Overview', { exact: true })).toBeVisible();
  await expect(menu.getByText('Runs', { exact: true })).toBeVisible();
  const menuActions = page.locator('.mobile-nav-menu-actions');
  await expect(menuActions.locator('.theme-control .action-label')).toBeVisible();
  await expect(menuActions.locator('.theme-control .action-label')).toHaveText('Appearance');
  await expect(menuActions.locator('.repository-link .action-label')).toBeVisible();
  await expect(menuActions.locator('.repository-link .action-label')).toHaveText('githubnext/gh-aw-cao');
  await expect(menuActions.locator('.account-menu')).toHaveCount(0);
  await expect(menu.locator('.octicon-goal')).toBeVisible();
  await expect(menu.getByText('Cost & efficiency', { exact: true })).toBeVisible();
  await menu.getByText('Cost & efficiency', { exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Cost & efficiency', level: 1 })).toBeVisible();
  await expect(page.locator('.primary-nav')).toHaveCSS('display', 'none');
  await expect(historyBack).toBeVisible();
  await expect(historyBack).toHaveCSS('border-radius', '50%');
  await expect(historyBack).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await historyBack.click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(historyBack).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('phone pages toggle between chart, full-view table, and card-list modes', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-view-mode-dashboard',
            title: 'Phone View Mode',
            pages: [{
              id: 'runs',
              kind: 'custom',
              title: 'Runs',
              views: [
                {
                  id: 'runs-chart',
                  title: 'Run trend',
                  data: { source: 'runs' },
                  mark: 'chart',
                  chart: 'line',
                  encoding: {
                    x: { field: 'started-at', type: 'temporal' },
                    y: { field: 'run-count', type: 'quantitative' }
                  }
                },
                {
                  id: 'runs-table',
                  title: 'Runs',
                  data: { source: 'runs' },
                  mark: 'table',
                  controls: 'interactive',
                  'lazy-list': true,
                  layout: 'full-view',
                  encoding: { columns: [{ field: 'run', title: 'Run' }] }
                }
              ]
            }]
          }
        },
        sources: {
          runs: {
            source: 'runs',
            rows: [{ run: '1', 'run-count': 1, 'started-at': '2026-09-16T10:00:00Z' }],
            metadata: {
              availability: 'available',
              completeness: 'complete',
              freshness: 'fresh'
            }
          }
        }
      }));
    </script>
  `);

  const root = page.locator('.dashboard-root');
  const chart = page.locator('[data-view-id="runs-chart"]');
  const table = page.locator('[data-view-id="runs-table"]');
  const viewModeToggle = page.locator('.mobile-view-mode-toggle');
  await expect(page.locator('[data-page-id="runs"] > .page-chrome > .filter-bar')).toBeHidden();
  await expect(viewModeToggle).toBeVisible();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Cards view');
  await expect(viewModeToggle.locator('.octicon-graph')).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(table).toBeHidden();
  await expect(root).not.toHaveClass(/dashboard-full-view/);

  await viewModeToggle.click();

  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Table view');
  await expect(viewModeToggle.locator('.octicon-stack')).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(table).toBeVisible();
  await expect(table.locator('.table-region')).toBeHidden();
  await expect(table.locator('[data-mobile-card-list]')).toBeVisible();
  await expect(root).toHaveClass(/dashboard-full-view/);

  await viewModeToggle.click();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Chart view');
  await expect(viewModeToggle.locator('.octicon-table')).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(table.locator('.table-region')).toBeVisible();
  await expect(table.locator('[data-mobile-card-list]')).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);
  await expect(table.getByRole('heading', { name: 'Runs', level: 3 })).toBeHidden();
  await expect(page.locator('[data-page-id="runs"] [data-view-mode-value="table"]')).toHaveAttribute('aria-pressed', 'true');
});

test('phone Workflows page cycles through chart, table, and card-list views', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workflowsPage = builtInPage('workflows');
  await page.evaluate(async ({ presenterModuleUrl, workflowsPage }) => {
    window.location.hash = '#page-workflows';
    const { renderDashboard } = await import(presenterModuleUrl);
    document.querySelector('#root')?.append(renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflows-view-mode-dashboard',
          title: 'Workflows View Mode',
          pages: [workflowsPage]
        }
      },
      sources: {
        'workflow-aic-per-run': {
          source: 'workflow-aic-per-run',
          rows: [{
            'campaign-name': 'Maintenance',
            repository: 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/aw-maintenance.md',
            'workflow-name': 'AW Maintenance',
            'workflow-label': 'githubnext/gh-aw-cao:.github/workflows/aw-maintenance.md',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review',
            'workflow-active': 'active',
            aic: 12,
            runs: 4,
            'aic-per-run': 3,
            ingestion: '100%',
            'workflow-link': { relation: 'workflow', href: '#page-workflow-runtime', label: 'View AW Maintenance' },
            'repository-link': { relation: 'repository', href: '#page-repository-detail', label: 'View githubnext/gh-aw-cao' }
          }],
          metadata: {
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        },
        'workflow-inventory': {
          source: 'workflow-inventory',
          rows: [{
            'campaign-name': 'Maintenance',
            repository: 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/aw-maintenance.md',
            'workflow-name': 'AW Maintenance',
            'workflow-label': 'githubnext/gh-aw-cao:.github/workflows/aw-maintenance.md',
            'workflow-role': 'orchestrator',
            'rollout-mode': 'review',
            'workflow-active': 'active',
            aic: 12,
            runs: 4,
            'aic-per-run': 3,
            ingestion: '100%',
            'workflow-link': { relation: 'workflow', href: '#page-workflow-runtime', label: 'View AW Maintenance' },
            'repository-link': { relation: 'repository', href: '#page-repository-detail', label: 'View githubnext/gh-aw-cao' }
          }],
          metadata: {
            availability: 'available',
            completeness: 'complete',
            freshness: 'fresh'
          }
        }
      }
    }));
  }, { presenterModuleUrl: buildPresenterModuleUrl(), workflowsPage });

  const chart = page.locator('[data-view-id="workflows-by-aic-per-run"]');
  const table = page.locator('[data-view-id="workflows-inventory"]');
  const viewModeToggle = page.locator('.mobile-view-mode-toggle');
  await expect(chart).toBeVisible();
  await expect(table).toBeHidden();

  await expect(page.locator('[data-page-id="workflows"] > .page-chrome > .filter-bar')).toBeHidden();
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Cards view');
  await viewModeToggle.click();
  await expect(chart).toBeHidden();
  await expect(table.locator('.table-region')).toBeHidden();
  await expect(table.locator('[data-mobile-card-list]')).toContainText('AW Maintenance');

  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Table view');
  await viewModeToggle.click();
  await expect(table.locator('.table-region')).toBeVisible();
  await expect(table.locator('tbody')).toContainText('AW Maintenance');
  await expect(viewModeToggle).toHaveAttribute('aria-label', 'Switch to Chart view');
});

test('phone full-view lazy tables switch between table and card-list modes', async ({ page }) => {
  const presenterModuleUrl = buildPresenterModuleUrl();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <div id="root"></div>
    <script type="module">
      import { renderDashboard } from ${JSON.stringify(presenterModuleUrl)};
      document.querySelector('#root').append(renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'phone-table-card-dashboard',
            title: 'Phone Table Cards',
            'card-templates': [{
              id: 'repository',
              icon: 'repo',
              title: { field: 'repository-coordinate' },
              labels: [],
              details: [{ field: 'organization', title: 'Organization' }]
            }],
            pages: [{
              id: 'repositories',
              kind: 'custom',
              title: 'Repositories',
              views: [{
                id: 'repositories-table',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                controls: 'interactive',
                'lazy-list': true,
                layout: 'full-view',
                encoding: {
                  columns: [
                    { field: 'repository-coordinate', type: 'nominal', title: 'Repository' },
                    { field: 'organization', type: 'nominal', title: 'Organization' }
                  ]
                }
              }]
            }]
          }
        },
        sources: {
          repositories: {
            source: 'repositories',
            rows: [{
              'repository-coordinate': 'githubnext/gh-aw-cao',
              organization: 'githubnext'
            }],
            metadata: {
              availability: 'available',
              completeness: 'complete',
              freshness: 'fresh'
            }
          }
        }
      }));
    </script>
  `);

  const root = page.locator('.dashboard-root');
  const table = page.locator('[data-view-id="repositories-table"] .table-region');
  const cards = page.locator('[data-mobile-card-list]');
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);

  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(table).toBeHidden();
  await expect(cards).toBeVisible();
  await expect(cards.locator('.entity-card-list-card')).toContainText('githubnext/gh-aw-cao');
  await expect(root).toHaveClass(/dashboard-full-view/);
  await expect(page.getByRole('heading', { name: 'Repositories', level: 3 })).toBeHidden();

  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await expect(root).toHaveClass(/dashboard-full-view/);
});
