// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderDashboardNavigation, enableDashboardNavigation } from '../../src/components/dashboard-navigation.js';

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

/** @param {string} key */
const press = (key) => document.activeElement?.dispatchEvent(
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
);

describe('dashboard keyboard navigation', () => {
  it('moves through expanded sidebar sections without activating links or hidden items', () => {
    const sidebar = renderDashboardNavigation([
      { id: 'overview', title: 'Overview' },
      { id: 'runs', title: 'Runs' },
      { id: 'issues', title: 'Issues' }
    ], 'Dashboard', [
      { label: 'Main', pages: ['overview', 'runs'] },
      { label: 'Other', pages: ['issues'] }
    ]);
    document.body.append(sidebar);
    enableDashboardNavigation(document.body);
    const [main, other] = /** @type {HTMLDetailsElement[]} */ ([...sidebar.querySelectorAll('.nav-section')]);
    const [overview, runs, issues] = [...sidebar.querySelectorAll('[data-nav-page-id]')];
    /** @type {HTMLElement} */ (overview).focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(runs);
    press('ArrowDown');
    expect(document.activeElement).toBe(other.querySelector('summary'));
    press('ArrowDown');
    expect(document.activeElement).toBe(other.querySelector('summary'));
    press('ArrowRight');
    expect(other.open).toBe(true);
    press('ArrowRight');
    expect(document.activeElement).toBe(issues);
    press('ArrowLeft');
    expect(document.activeElement).toBe(other.querySelector('summary'));
    press('ArrowLeft');
    expect(other.open).toBe(false);
    press('Home');
    expect(document.activeElement).toBe(main.querySelector('summary'));
    press('End');
    expect(document.activeElement).toBe(other.querySelector('summary'));
    expect(window.location.hash).toBe('');
  });

  it('moves between mobile view links while retaining Escape behavior', () => {
    const sidebar = renderDashboardNavigation([
      { id: 'overview', title: 'Overview' },
      { id: 'runs', title: 'Runs' },
      { id: 'issues', title: 'Issues' }
    ], 'Dashboard', [{ label: 'Main', pages: ['overview', 'runs', 'issues'] }]);
    document.body.append(sidebar);
    enableDashboardNavigation(document.body);
    const menu = /** @type {HTMLDetailsElement} */ (sidebar.querySelector('.mobile-nav-menu'));
    const links = [...menu.querySelectorAll('[data-mobile-nav-page-id]')];
    menu.open = true;
    const summary = /** @type {HTMLElement} */ (menu.querySelector('summary'));
    summary.focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(links[0]);
    press('End');
    expect(document.activeElement).toBe(links[2]);
    press('ArrowUp');
    expect(document.activeElement).toBe(links[1]);
    press('Home');
    expect(document.activeElement).toBe(links[0]);
    press('Escape');
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(window.location.hash).toBe('');
  });
});
