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
 *   landmarkLabel: string
 * }} WorkViewComposition
 */

const WORK_VIEW_COMPOSITIONS = /** @type {Readonly<Record<WorkViewBody, WorkViewComposition>>} */ ({
  board: { key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board' },
  tasks: { key: 'tasks', className: 'work-tasks', title: 'Tasks', landmarkLabel: 'Tasks' },
  roadmap: { key: 'roadmap', className: 'work-roadmap', title: 'Roadmap', landmarkLabel: 'Roadmap' }
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

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   sources: string[],
 *   description?: string,
 *   body?: WorkViewBody,
 *   sections?: WorkViewBody[],
 *   layout?: 'full'|'wide'|'compact'
 * }} options
 */
export function createWorkProjectView(options) {
  const config = Array.isArray(options.sections) && options.sections.length > 0
    ? { sections: options.sections }
    : options.body
      ? { body: workViewCompositionForBody(options.body).key }
      : { sections: defaultWorkViewComposition().map((section) => section.key) };
  return {
    id: options.id,
    title: options.title,
    ...(typeof options.description === 'string' ? { description: options.description } : {}),
    data: {
      sources: options.sources
    },
    mark: 'element',
    element: 'work-project-view',
    config,
    ...(options.layout ? { layout: options.layout } : {})
  };
}
