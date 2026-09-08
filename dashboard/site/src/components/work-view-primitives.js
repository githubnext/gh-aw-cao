/**
 * Shared declarative work view composition primitives.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';
import { WORK_VIEW_SECTION_KEYS } from './route-body-specification.js';

/** @typedef {'board'|'tasks'|'roadmap'} WorkViewBody */

export const WORK_VIEW_BODY_VALUES = /** @type {readonly WorkViewBody[]} */ (WORK_VIEW_SECTION_KEYS);

const WORK_VIEW_CONFIG = createElementCompositionConfig(WORK_VIEW_BODY_VALUES, /** @type {WorkViewBody} */ ('board'));

/**
 * @typedef {{
 *   key: WorkViewBody,
 *   className: string,
 *   title: string,
 *   landmarkLabel: string
 * }} WorkViewComposition
 */

const WORK_VIEW_COMPOSITIONS = /** @type {Readonly<Record<WorkViewBody, WorkViewComposition>>} */ ({
  board: { key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board' },
  tasks: { key: 'tasks', className: 'work-tasks', title: 'Tasks', landmarkLabel: 'Tasks' },
  roadmap: { key: 'roadmap', className: 'work-roadmap', title: 'Execution timeline', landmarkLabel: 'Execution timeline' }
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
