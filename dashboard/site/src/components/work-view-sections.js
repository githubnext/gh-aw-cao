/**
 * Declarative work view section renderers.
 */

import { WORK_VIEW_SECTION_KEYS } from './route-body-specification.js'

/** @typedef {'renderBoard'|'renderTasks'|'renderRoadmap'} WorkViewRendererName */

const WORK_VIEW_SECTION_RENDERERS = {
  board: 'renderBoard',
  tasks: 'renderTasks',
  roadmap: 'renderRoadmap',
}

/**
 * @param {string} section
 * @returns {section is keyof typeof WORK_VIEW_SECTION_RENDERERS}
 */
export function isWorkViewSection(section) {
  return (
    typeof section === 'string' &&
    WORK_VIEW_SECTION_KEYS.includes(/** @type {typeof WORK_VIEW_SECTION_KEYS[number]} */ (section)) &&
    Object.hasOwn(WORK_VIEW_SECTION_RENDERERS, section)
  )
}

/**
 * @param {string} section
 * @param {Record<WorkViewRendererName, unknown>} renderers
 * @returns {WorkViewRendererName | null}
 */
export function workViewSectionRenderer(section, renderers) {
  if (!isWorkViewSection(section)) return null
  const rendererName = /** @type {WorkViewRendererName} */ (WORK_VIEW_SECTION_RENDERERS[section])
  return rendererName && typeof renderers[rendererName] === 'function' ? rendererName : null
}
