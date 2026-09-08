import { h } from '../dom.js';
import { renderIconSpan } from './ui-primitives.js';

/**
 * @typedef {{
 *   key: string,
 *   title: string,
 *   icon: string,
 *   href: string
 * }} WorkNavigationItem
 */

/**
 * @param {WorkNavigationItem[]} items
 * @param {string} activeKey
 * @returns {HTMLElement}
 */
export function renderWorkViewNavigation(items, activeKey) {
  if (items.length === 0) return h('nav', { className: 'work-project-tabs', 'aria-label': 'Work views' });
  return h(
    'nav',
    { className: 'work-project-tabs', 'aria-label': 'Work views' },
    ...items.map((item) => h(
      'a',
      {
        href: item.href,
        'aria-current': item.key === activeKey ? 'page' : undefined
      },
      renderIconSpan('work-project-tab-icon', item.icon, { ariaHidden: true }),
      item.title
    ))
  );
}
