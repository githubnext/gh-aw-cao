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
        { label: 'Reports', icon: 'issue', href: '#page-two', current: true }
      ]
    });

    expect(rendered.className).toBe('repository-tabs workflow-tabs');
    expect(rendered.getAttribute('aria-label')).toBe('Workflow views');
    expect([...rendered.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['Insights', '#page-one', null],
      ['Reports', '#page-two', 'page']
    ]);
  });

  it('renders interactive tabs and supports roving selection with keyboard navigation', () => {
    const onSelect = vi.fn();
    const rendered = renderInteractiveTabs({
      className: 'package-mode-tabs',
      ariaLabel: 'Filter package activity by mode',
      panelId: 'packages-mode-panel',
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
