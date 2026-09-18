// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { enableDashboardNavigation, renderDashboardNavigation } from '../../src/components/dashboard-navigation.js';
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
