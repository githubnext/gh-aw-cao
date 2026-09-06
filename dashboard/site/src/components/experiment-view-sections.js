/**
 * Declarative experiment view section renderers.
 */

/**
 * @typedef {Record<string, any>} ExperimentViewRenderers
 */

/** @type {Record<string, keyof ExperimentViewRenderers>} */
const EXPERIMENT_VIEW_SECTION_RENDERERS = {
  overview: 'renderOverview',
  table: 'renderTable',
  detail: 'renderDetail'
};

/**
 * @param {string} section
 * @returns {section is keyof typeof EXPERIMENT_VIEW_SECTION_RENDERERS}
 */
export function isExperimentViewSection(section) {
  return Object.hasOwn(EXPERIMENT_VIEW_SECTION_RENDERERS, section);
}

/**
 * @param {string} section
 * @param {ExperimentViewRenderers} renderers
 * @returns {keyof ExperimentViewRenderers | null}
 */
export function experimentViewSectionRenderer(section, renderers) {
  const rendererName = EXPERIMENT_VIEW_SECTION_RENDERERS[section];
  return rendererName && typeof renderers[rendererName] === 'function'
    ? rendererName
    : null;
}
