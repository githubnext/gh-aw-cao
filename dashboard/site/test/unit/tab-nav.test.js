// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderInteractiveTabs, renderLinkTabs, updateInteractiveTabSelection } from '../../src/components/tab-nav.js';

describe('tab-nav', () => {
  it('renders link tabs with icons and current page markers', () => {
    const rendered = renderLinkTabs({
      className: 'repository-tabs workflow-tabs',
      ariaLabel: 'Workflow views',
      tabs: [
        { label: 'Insights', icon: 'graph', href: '#page-one' },
        { label: 'Reports', icon: 'issue', href: '#page-two', current: true, count: 2, trailingIcon: 'chevron-right' }
      ]
    });

    expect(rendered.className).toBe('repository-tabs workflow-tabs');
    expect(rendered.getAttribute('aria-label')).toBe('Workflow views');
    expect([...rendered.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['Insights', '#page-one', null],
      ['Reports2', '#page-two', 'page']
    ]);
    expect(rendered.querySelector('.count-badge')?.getAttribute('aria-label')).toBe('2 current reports');
    expect(rendered.querySelector('.tab-trailing-icon')?.classList).toContain('octicon-chevron-right');
  });

  it('moves focus among route links without changing the current page until activation', () => {
    const rendered = renderLinkTabs({
      className: 'repository-tabs',
      ariaLabel: 'Workflow views',
      tabs: [
        { label: 'Overview', icon: 'home', href: '#page-overview', current: true },
        { label: 'Runs', icon: 'play', href: '#page-runs' },
        { label: 'Issues', icon: 'issue', href: '#page-issues' }
      ]
    });
    document.body.append(rendered);
    const links = [...rendered.querySelectorAll('a')];
    /** @param {string} key */
    const press = (key) => document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
    links[0].focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(links[1]);
    press('End');
    expect(document.activeElement).toBe(links[2]);
    press('ArrowRight');
    expect(document.activeElement).toBe(links[0]);
    press('ArrowLeft');
    expect(document.activeElement).toBe(links[2]);
    press('Home');
    expect(document.activeElement).toBe(links[0]);
    expect(links.map((link) => link.tabIndex)).toEqual([0, 0, 0]);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(window.location.hash).not.toBe('#page-runs');
    rendered.remove();
  });

  it('renders interactive tabs and supports roving selection with keyboard navigation', () => {
    const onSelect = vi.fn();
    const rendered = renderInteractiveTabs({
      className: 'campaign-mode-tabs',
      ariaLabel: 'Filter campaign activity by mode',
      panelId: 'campaigns-mode-panel',
      onSelect,
      tabs: [
        { label: 'All', value: 'all', selected: true },
        { label: 'Review', value: 'review' },
        { label: 'Live', value: 'live' }
      ]
    });
    document.body.append(rendered);

    const buttons = /** @type {HTMLButtonElement[]} */ ([...rendered.querySelectorAll('[role="tab"]')]);
    expect(buttons.map((button) => [button.textContent, button.getAttribute('data-tab-value'), button.getAttribute('aria-selected'), button.tabIndex])).toEqual([
      ['All', 'all', 'true', 0],
      ['Review', 'review', 'false', -1],
      ['Live', 'live', 'false', -1]
    ]);

    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('review');
    expect(document.activeElement).toBe(buttons[1]);

    updateInteractiveTabSelection(rendered, 'review');
    expect(buttons.map((button) => [button.getAttribute('aria-selected'), button.tabIndex])).toEqual([
      ['false', -1],
      ['true', 0],
      ['false', -1]
    ]);

    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith('live');
    expect(document.activeElement).toBe(buttons[2]);
  });
});
