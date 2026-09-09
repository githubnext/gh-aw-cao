/**
 * Shared declarative work view chrome derived from canonical body values.
 */

import { h } from '../dom.js';
import { renderIconSpan } from './ui-primitives.js';
import { WORK_VIEW_BODY_VALUES, workViewCompositionForBody } from './work-view-primitives.js';

const WORK_VIEW_ICONS = /** @type {const} */ ({
  board: 'project-roadmap',
  tasks: 'table',
  roadmap: 'calendar'
});

/**
 * @typedef {import('./work-view-primitives.js').WorkViewBody} WorkViewBody
 */

/**
 * @typedef {{
 *   key: WorkViewBody,
 *   title: string,
 *   landmarkLabel: string,
 *   className: string,
 *   pageId: string,
 *   href: string,
 *   icon: string
 * }} WorkViewChrome
 */

/**
 * @param {unknown} body
 * @returns {WorkViewChrome}
 */
export function workViewChromeForBody(body) {
  const composition = workViewCompositionForBody(body);
  return {
    ...composition,
    pageId: workRoutePageId(composition.key),
    href: `#page-${workRoutePageId(composition.key)}`,
    icon: WORK_VIEW_ICONS[composition.key]
  };
}

/**
 * @returns {WorkViewChrome[]}
 */
export function workViewChromes() {
  return /** @type {readonly WorkViewBody[]} */ (WORK_VIEW_BODY_VALUES).map((body) => workViewChromeForBody(body));
}

/**
 * @param {WorkViewChrome[]} items
 * @param {string} activeKey
 * @returns {HTMLElement}
 */
export function renderWorkViewNavigation(items, activeKey) {
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

/**
 * @param {WorkViewChrome} section
 * @param {number} count
 * @param {HTMLElement | null} trailing
 * @returns {HTMLElement}
 */
export function renderWorkSectionToolbar(section, count, trailing = null) {
  return h(
    'div',
    { className: 'work-section-toolbar' },
    h(
      'div',
      { className: 'work-section-toolbar-title' },
      renderIconSpan('work-section-toolbar-icon', section.icon, { ariaHidden: true }),
      h('strong', null, section.title),
      h('span', null, `${count} items`)
    ),
    trailing
  );
}

/**
 * @param {WorkViewBody} body
 * @returns {string}
 */
function workRoutePageId(body) {
  return body === 'board' ? 'work' : `work-${body}`;
}
