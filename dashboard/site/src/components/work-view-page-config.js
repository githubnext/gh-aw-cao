/**
 * Declarative work page routing and navigation derived from reusable section composition.
 */

import { WORK_VIEW_BODY_VALUES, workViewCompositionForBody } from './work-view-primitives.js';

/**
 * @typedef {{
 *   body: import('./work-view-primitives.js').WorkViewBody,
 *   title: string,
 *   icon: string,
 *   pageId: string,
 *   href: string
 * }} WorkViewPageConfig
 */

const WORK_VIEW_PAGE_CONFIG = /** @type {const} */ ({
  board: { pageId: 'work', icon: 'project-roadmap' },
  tasks: { pageId: 'work-tasks', icon: 'table' },
  roadmap: { pageId: 'work-roadmap', icon: 'project-roadmap' }
});

/**
 * @param {unknown} body
 * @returns {WorkViewPageConfig}
 */
export function workViewPageConfigForBody(body) {
  const composition = workViewCompositionForBody(body);
  const page = WORK_VIEW_PAGE_CONFIG[composition.key];
  return {
    body: composition.key,
    title: composition.title,
    icon: page.icon,
    pageId: page.pageId,
    href: `#page-${page.pageId}`
  };
}

/**
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {WorkViewPageConfig[]}
 */
export function workViewPageConfigs(config) {
  const selected = Array.isArray(config?.sections) && config.sections.length > 0
    ? new Set(config.sections.filter((body) => typeof body === 'string'))
    : new Set([config?.body].filter((body) => typeof body === 'string'));
  const orderedBodies = WORK_VIEW_BODY_VALUES.toSorted((left, right) => {
    if (selected.has(left) === selected.has(right)) return 0;
    return selected.has(left) ? -1 : 1;
  });
  return orderedBodies.map((body) => workViewPageConfigForBody(body));
}

/**
 * @returns {WorkViewPageConfig[]}
 */
export function defaultWorkViewPageConfigs() {
  return WORK_VIEW_BODY_VALUES.map((body) => workViewPageConfigForBody(body));
}
