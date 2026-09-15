import { WORK_VIEW_BODY_VALUES, workViewCompositionForBody } from './work-view-primitives.js';

const WORK_ROUTE_PAGE_BY_BODY = /** @type {const} */ ({
  board: 'work',
  tasks: 'work-tasks',
  roadmap: 'work-roadmap'
});

const WORK_ROUTE_ICON_BY_BODY = /** @type {const} */ ({
  board: 'project-roadmap',
  tasks: 'table',
  roadmap: 'calendar'
});

/**
 * @typedef {{
 *   key: import('./work-view-primitives.js').WorkViewBody,
 *   title: string,
 *   icon: string,
 *   pageId: string,
 *   href: string
 * }} WorkRoutePageConfig
 */

/**
 * @param {unknown} body
 * @returns {WorkRoutePageConfig}
 */
export function workRoutePageConfigForBody(body) {
  const composition = workViewCompositionForBody(body);
  return {
    key: composition.key,
    title: composition.title,
    icon: WORK_ROUTE_ICON_BY_BODY[composition.key],
    pageId: WORK_ROUTE_PAGE_BY_BODY[composition.key],
    href: `#page-${WORK_ROUTE_PAGE_BY_BODY[composition.key]}`
  };
}

/**
 * @returns {WorkRoutePageConfig[]}
 */
export function workRoutePageConfigs() {
  return WORK_VIEW_BODY_VALUES.map((body) => workRoutePageConfigForBody(body));
}
