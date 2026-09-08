import { h } from '../dom.js';
import { renderIconSpan } from './ui-primitives.js';

/**
 * @typedef {{
 *   body?: string,
 *   key?: string,
 *   title: string,
 *   icon: string,
 *   href: string
 * }} WorkNavigationItem
 */

/**
 * @param {WorkNavigationItem[]} items
 * @param {string} activeBody
 * @returns {HTMLElement}
 */
export function renderWorkViewNavigation(items, activeBody) {
  return h(
    'nav',
    { className: 'work-project-tabs', 'aria-label': 'Work views' },
    ...items.map((item) => h(
      'a',
      {
        href: item.href,
        'aria-current': (item.body ?? item.key) === activeBody ? 'page' : undefined
      },
      renderIconSpan('work-project-tab-icon', item.icon, { ariaHidden: true }),
      item.title
    ))
  );
}
