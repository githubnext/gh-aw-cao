// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { enableDashboardNavigation, renderDashboardNavigation, syncMobileViewModeToggle } from '../../src/components/dashboard-navigation.js';
import { buildChartPoints, prepareChartPoints, prepareTableRows } from '../../src/components/view-data.js';

describe('dashboard sidebar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('owns its navigation markup and collapse interaction', () => {
    const sidebar = renderDashboardNavigation([
      { id: 'overview', title: 'Overview', icon: 'home' },
      { id: 'runs', title: 'Runs', icon: 'play' }
    ], 'Example', [{ label: 'Main', pages: ['overview', 'runs'] }]);
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.append(sidebar);
    const root = document.createElement('div');
    root.append(shell);
    document.body.append(root);

    enableDashboardNavigation(root);

    expect(sidebar.dataset.defaultPageId).toBe('overview');
    expect(sidebar.querySelectorAll('[data-nav-page-id]')).toHaveLength(2);
    const backIcon = sidebar.querySelector('.mobile-history-back .octicon');
    expect(backIcon).toBeInstanceOf(SVGElement);
    if (!(backIcon instanceof SVGElement)) return;
    expect(backIcon.classList.contains('octicon-chevron-left')).toBe(true);
    expect(backIcon.classList.contains('mobile-history-back-icon')).toBe(true);
    const toggle = sidebar.querySelector('.sidebar-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    if (!(toggle instanceof HTMLButtonElement)) return;
    toggle.click();
    expect(shell.classList.contains('sidebar-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('groups experimental pages in one explicit section', () => {
    const sidebar = renderDashboardNavigation([
      { id: 'overview', title: 'Overview' },
      { id: 'preview-a', title: 'Preview A' },
      { id: 'preview-b', title: 'Preview B' }
    ], 'Example', [
      { label: 'Main', pages: ['overview'] },
      { label: 'Alpha', pages: ['preview-a'], experimental: true },
      { label: 'Beta', pages: ['preview-b'], experimental: true }
    ]);

    const labels = [...sidebar.querySelectorAll('.nav-section-label')].map((element) => element.textContent);
    expect(labels).toEqual(['Main', 'Experimental']);
  });

  it('anchors bottom navigation sections after the standard sections', () => {
    const sidebar = renderDashboardNavigation([
      { id: 'overview', title: 'Overview' },
      { id: 'runs', title: 'Runs' },
      { id: 'maintenance', title: 'Maintenance' },
      { id: 'configuration', title: 'Settings' }
    ], 'Example', [
      { label: 'Main', pages: ['overview'] },
      { label: 'Data', pages: ['runs'] },
      { label: 'Manage', placement: 'bottom', pages: ['maintenance', 'configuration'] }
    ]);

    const sectionLabels = [...sidebar.querySelectorAll('.nav-section-label')].map((element) => element.textContent);
    expect(sectionLabels).toEqual(['Main', 'Data', 'Manage']);
    const bottomSection = sidebar.querySelector('.nav-section-bottom');
    expect(bottomSection?.querySelector('.nav-section-label')?.textContent).toBe('Manage');
    expect([...bottomSection?.querySelectorAll('[data-nav-page-id]') ?? []].map((element) => element.textContent))
      .toEqual(['Maintenance', 'Settings']);
    expect(bottomSection?.hasAttribute('open')).toBe(true);
  });

  it('cycles the active page view from the mobile header control', () => {
    const sidebar = renderDashboardNavigation([{ id: 'runs', title: 'Runs' }], 'Example', undefined);
    const page = document.createElement('section');
    page.className = 'dashboard-page';
    for (const [mode, pressed] of [['chart', 'true'], ['card', 'false'], ['table', 'false']]) {
      const button = document.createElement('button');
      button.dataset.viewModeValue = mode;
      button.setAttribute('aria-pressed', pressed);
      button.addEventListener('click', () => {
        for (const candidate of page.querySelectorAll('[data-view-mode-value]')) {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        }
      });
      page.append(button);
    }
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.append(sidebar, page);
    const root = document.createElement('div');
    root.append(shell);
    document.body.append(root);

    enableDashboardNavigation(root);
    syncMobileViewModeToggle(root);

    const toggle = /** @type {HTMLButtonElement} */ (sidebar.querySelector('.mobile-view-mode-toggle'));
    expect(toggle.hidden).toBe(false);
    expect(toggle.dataset.viewMode).toBe('chart');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to Cards view');
    expect(toggle.querySelector('.octicon-graph')).not.toBeNull();

    toggle.click();
    expect(toggle.dataset.viewMode).toBe('card');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to Table view');
    expect(toggle.querySelector('.octicon-stack')).not.toBeNull();
  });
});

describe('declarative view data', () => {
  it('aggregates, orders, and limits table rows', () => {
    expect(prepareTableRows([
      { campaign: 'alpha', runs: 2 },
      { campaign: 'alpha', runs: 3 },
      { campaign: 'beta', runs: 7 }
    ], [
      { field: 'campaign' },
      { field: 'runs', aggregate: 'sum', as: 'total' }
    ], {
      'order-by': [{ field: 'total', direction: 'desc' }],
      limit: 1
    })).toEqual([{ campaign: 'beta', total: 7 }]);
  });

  it('builds and orders aggregated chart points', () => {
    const points = buildChartPoints('runs', 'Runs', [
      { day: '2026-09-15', status: 'success', count: 2 },
      { day: '2026-09-15', status: 'success', count: 3 },
      { day: '2026-09-16', status: 'failure', count: 1 }
    ], { field: 'day' }, { field: 'count', aggregate: 'sum', as: 'total' }, { field: 'status' }, null);

    expect(prepareChartPoints(points, { field: 'day' }, { field: 'count', aggregate: 'sum', as: 'total' }, { field: 'status' }, {
      'order-by': [{ field: 'total', direction: 'desc' }]
    }).map(({ x, y, color }) => ({ x, y, color }))).toEqual([
      { x: '2026-09-15', y: 5, color: 'success' },
      { x: '2026-09-16', y: 1, color: 'failure' }
    ]);
  });
});
