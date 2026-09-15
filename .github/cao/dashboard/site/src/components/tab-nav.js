/**
 * Shared dashboard tab navigation primitives.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';

/**
 * @typedef {{
 *   label: string,
 *   icon: string,
 *   href: string,
 *   current?: boolean
 * }} LinkTab
 */

/**
 * @typedef {{
 *   label: string,
 *   value: string,
 *   selected?: boolean,
 *   dataset?: Record<string, string>
 * }} InteractiveTab
 */

/**
 * @param {{
 *   className: string,
 *   ariaLabel: string,
 *   tabs: LinkTab[]
 * }} options
 * @returns {HTMLElement}
 */
export function renderLinkTabs({ className, ariaLabel, tabs }) {
  return h(
    'nav',
    { className, 'aria-label': ariaLabel },
    ...tabs.map(({ label, icon, href, current }) => h(
      'a',
      { href, 'aria-current': current ? 'page' : undefined },
      octicon(icon),
      h('span', null, label)
    ))
  );
}

/**
 * @param {{
 *   className: string,
 *   ariaLabel: string,
 *   panelId: string,
 *   tabs: InteractiveTab[],
 *   onSelect: (value: string) => void
 * }} options
 * @returns {HTMLDivElement}
 */
export function renderInteractiveTabs({ className, ariaLabel, panelId, tabs, onSelect }) {
  /** @type {HTMLButtonElement[]} */
  const buttons = [];

  return /** @type {HTMLDivElement} */ (h(
    'div',
    {
      className,
      role: 'tablist',
      'aria-label': ariaLabel,
      'aria-orientation': 'horizontal'
    },
    ...tabs.map(({ label, value, selected, dataset }, index) => {
      const button = /** @type {HTMLButtonElement} */ (h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-controls': panelId,
          'aria-selected': selected ? 'true' : 'false',
          tabIndex: selected ? 0 : -1,
          dataset: { tabValue: value, ...dataset },
          onclick: () => onSelect(value)
        },
        label
      ));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = buttons.indexOf(button);
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (currentIndex + ((event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1) + buttons.length) % buttons.length;
        const nextButton = buttons[nextIndex];
        nextButton?.click();
        nextButton?.focus();
      });
      buttons.splice(index, 0, button);
      return button;
    })
  ));
}

/**
 * @param {ParentNode} root
 * @param {string} selectedValue
 * @param {string} [attributeName]
 */
export function updateInteractiveTabSelection(root, selectedValue, attributeName = 'data-tab-value') {
  const buttons = root.querySelectorAll('[role="tab"]');
  for (const button of buttons) {
    const element = /** @type {HTMLElement} */ (button);
    const selected = element.getAttribute(attributeName) === selectedValue
      || element.dataset.tabValue === selectedValue
      || element.dataset.packageMode === selectedValue
      || element.dataset.reportMode === selectedValue;
    element.setAttribute('aria-selected', String(selected));
    element.tabIndex = selected ? 0 : -1;
  }
}
