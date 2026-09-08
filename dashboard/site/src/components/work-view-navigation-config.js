import { workViewCompositionForBody, WORK_VIEW_BODY_VALUES } from './work-view-primitives.js';

/**
 * @typedef {{
 *   key: import('./work-view-primitives.js').WorkViewBody,
 *   title: string,
 *   icon: string,
 *   pageId: string,
 *   href: string
 * }} WorkNavigationConfig
 */

const WORK_ROUTE_ICON_BY_BODY = /** @type {const} */ ({
  board: 'project-roadmap',
  tasks: 'table',
  roadmap: 'calendar'
});

/**
 * @param {Array<{ key?: string, title?: string, icon?: string, pageId?: string, href?: string }> | undefined} navigation
 * @returns {WorkNavigationConfig[]}
 */
export function resolveWorkViewNavigation(navigation) {
  const candidates = Array.isArray(navigation) ? navigation : [];
  const resolved = WORK_VIEW_BODY_VALUES.flatMap((body) => {
    const item = candidates.find((candidate) => candidate?.key === body);
    if (!item || typeof item.pageId !== 'string' || typeof item.href !== 'string') return [];
    const composition = workViewCompositionForBody(body);
    return [{
      key: composition.key,
      title: typeof item.title === 'string' && item.title.length > 0 ? item.title : composition.title,
      icon: typeof item.icon === 'string' && item.icon.length > 0 ? item.icon : WORK_ROUTE_ICON_BY_BODY[composition.key],
      pageId: item.pageId,
      href: item.href
    }];
  });
  return resolved;
}
