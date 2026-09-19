// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { declaredRouteTabs, renderDeclaredRouteTabs } from '../../src/components/route-tabs.js';

const tabs = [
  { id: 'overview', label: 'Overview', icon: 'repo', page: 'repository-detail' },
  { id: 'settings', label: 'Settings', icon: 'gear', page: 'repository-settings' }
];

describe('declaredRouteTabs', () => {
  it('reads well-formed declared tabs and the current tab', () => {
    expect(declaredRouteTabs({ tabs, tab: 'settings' })).toEqual({ tabs, currentTab: 'settings' });
  });

  it('ignores routes without usable tab declarations', () => {
    expect(declaredRouteTabs(null)).toBeNull();
    expect(declaredRouteTabs({})).toBeNull();
    expect(declaredRouteTabs({ tabs: [{ id: 'overview' }] })).toBeNull();
  });
});

describe('renderDeclaredRouteTabs', () => {
  /** @type {HTMLElement} */
  let element;

  beforeEach(() => {
    element = renderDeclaredRouteTabs({ routeParameter: 'repository', currentTab: 'settings', tabs });
  });

  it('renders no tabs until a route value is bound', () => {
    expect(element.querySelectorAll('a').length).toBe(0);
  });

  it('renders declared tabs with route-bound hrefs when the route resolves', () => {
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo repo' }
    }));
    const links = [...element.querySelectorAll('a')];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['Overview', 'Settings']);
    expect(links[0].getAttribute('href')).toBe('#page-repository-detail?repository=octo-org%2Focto%20repo');
    expect(links[1].getAttribute('aria-current')).toBe('page');
  });

  it('ignores route changes for other parameters and clears on an empty value', () => {
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'ci' }
    }));
    expect(element.querySelectorAll('a').length).toBe(0);
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: 'octo-org/octo-repo' }
    }));
    expect(element.querySelectorAll('a').length).toBe(2);
    element.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'repository', value: '  ' }
    }));
    expect(element.querySelectorAll('a').length).toBe(0);
  });
});
