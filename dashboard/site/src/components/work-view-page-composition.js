/**
 * Shared declarative page composition for work-project-view variants.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';
import { WORK_VIEW_BODY_VALUES } from './work-view-primitives.js';

/** @typedef {import('./work-view-primitives.js').WorkViewBody} WorkViewBody */

const WORK_VIEW_PAGE_CONFIG = createElementCompositionConfig(WORK_VIEW_BODY_VALUES, /** @type {WorkViewBody} */ ('board'));

const WORK_VIEW_PAGE_COMPOSITIONS = /** @type {const} */ ({
  board: { key: 'board', icon: 'project-roadmap', pageId: 'work', href: '#page-work' },
  tasks: { key: 'tasks', icon: 'table', pageId: 'work-tasks', href: '#page-work-tasks' },
  roadmap: { key: 'roadmap', icon: 'calendar', pageId: 'work-roadmap', href: '#page-work-roadmap' }
});

/**
 * @param {unknown} body
 */
export function workViewPageCompositionForBody(body) {
  return selectElementComposition(WORK_VIEW_PAGE_COMPOSITIONS, WORK_VIEW_PAGE_CONFIG, body);
}

/**
 * @param {{ key: WorkViewBody, title: string }[]} sections
 */
export function workViewPageCompositions(sections) {
  return sections.map((section) => ({
    ...workViewPageCompositionForBody(section.key),
    title: section.title
  }));
}
