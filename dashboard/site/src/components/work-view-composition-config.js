/**
 * Shared declarative work view composition primitives.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';

/** @typedef {'board'|'tasks'|'roadmap'} WorkViewBody */

export const WORK_VIEW_BODY_VALUES = /** @type {const} */ (['board', 'tasks', 'roadmap']);

const WORK_VIEW_CONFIG = createElementCompositionConfig(WORK_VIEW_BODY_VALUES, /** @type {WorkViewBody} */ ('board'));

/**
 * @typedef {{
 *   key: WorkViewBody,
 *   className: string,
 *   title: string,
 *   landmarkLabel: string,
 *   icon: string,
 *   href: string
 * }} WorkViewComposition
 */

const WORK_VIEW_COMPOSITIONS = /** @type {Readonly<Record<WorkViewBody, WorkViewComposition>>} */ ({
  board: { key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board', icon: 'project-roadmap', href: '#page-work' },
  tasks: { key: 'tasks', className: 'work-tasks', title: 'Table', landmarkLabel: 'Tasks', icon: 'table', href: '#page-work-tasks' },
  roadmap: { key: 'roadmap', className: 'work-roadmap', title: 'Roadmap', landmarkLabel: 'Roadmap', icon: 'calendar', href: '#page-work-roadmap' }
});

/**
 * @param {unknown} body
 * @returns {WorkViewComposition}
 */
export function workViewCompositionForBody(body) {
  return selectElementComposition(WORK_VIEW_COMPOSITIONS, WORK_VIEW_CONFIG, body);
}

/**
 * @returns {WorkViewComposition[]}
 */
export function defaultWorkViewComposition() {
  return WORK_VIEW_BODY_VALUES.map((body) => workViewCompositionForBody(body));
}
