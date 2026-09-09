import { WORK_VIEW_BODY_VALUES } from './work-view-primitives.js';
import { workViewChromeForBody } from './work-view-chrome.js';

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
  const composition = workViewChromeForBody(body);
  return {
    key: composition.key,
    title: composition.title,
    icon: composition.icon,
    pageId: composition.pageId,
    href: composition.href
  };
}

/**
 * @returns {WorkRoutePageConfig[]}
 */
export function workRoutePageConfigs() {
  return WORK_VIEW_BODY_VALUES.map((body) => workRoutePageConfigForBody(body));
}
