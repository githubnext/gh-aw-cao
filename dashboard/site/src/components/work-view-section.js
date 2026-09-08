import { h } from '../dom.js';

/**
 * @param {{
 *   className: string,
 *   id: string,
 *   landmarkLabel: string,
 *   title: string,
 *   children: Array<HTMLElement | null>
 * }} options
 * @returns {HTMLElement}
 */
export function renderWorkViewSection(options) {
  return h(
    'section',
    { className: options.className, id: options.id, 'aria-label': options.landmarkLabel },
    options.title
      ? h('header', { className: 'work-view-section-header' }, h('h3', null, options.title))
      : null,
    ...options.children.filter((child) => child instanceof HTMLElement)
  );
}
