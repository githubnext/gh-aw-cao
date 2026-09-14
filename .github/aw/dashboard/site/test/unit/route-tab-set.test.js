// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderRouteTabSet } from '../../src/components/route-tab-set.js';

describe('renderRouteTabSet', () => {
  it('renders a reusable tab set with one current tab', () => {
    const rendered = renderRouteTabSet({
      className: 'route-tabs',
      ariaLabel: 'Reusable route tabs',
      currentTab: 'reports',
      tabs: [
        { id: 'insights', label: 'Insights', icon: 'graph', href: '#page-insights' },
        { id: 'reports', label: 'Reports', icon: 'issue', href: '#page-reports' }
      ]
    });

    expect(rendered.getAttribute('aria-label')).toBe('Reusable route tabs');
    expect(rendered.querySelector('[aria-current="page"]')?.textContent).toBe('Reports');
    expect([...rendered.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '#page-insights',
      '#page-reports'
    ]);
  });
});
