/**
 * Declarative work view section renderers.
 */

/** @typedef {'renderBoard'|'renderTasks'|'renderRoadmap'} WorkViewRendererName */
/** @typedef {'board'|'tasks'|'roadmap'} WorkViewSection */

const WORK_VIEW_SECTION_RENDERERS = /** @type {Record<WorkViewSection, WorkViewRendererName>} */ ({
  board: 'renderBoard',
  tasks: 'renderTasks',
  roadmap: 'renderRoadmap'
});

/**
 * @param {string} section
 * @returns {section is keyof typeof WORK_VIEW_SECTION_RENDERERS}
 */
export function isWorkViewSection(section) {
  return Object.hasOwn(WORK_VIEW_SECTION_RENDERERS, section);
}

/**
 * @param {string} section
 * @param {Record<WorkViewRendererName, unknown>} renderers
 * @returns {WorkViewRendererName | null}
 */
export function workViewSectionRenderer(section, renderers) {
  if (!isWorkViewSection(section)) return null;
  const rendererName = /** @type {WorkViewRendererName} */ (WORK_VIEW_SECTION_RENDERERS[section]);
  return rendererName && typeof renderers[rendererName] === 'function'
    ? rendererName
    : null;
}
