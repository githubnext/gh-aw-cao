/**
 * Declarative work view section renderers.
 */

import {
  renderWorkBoardSection,
  renderWorkRoadmapSection,
  renderWorkTaskSection
} from './work-project-sections.js';

const WORK_VIEW_SECTION_RENDERERS = {
  board: renderWorkBoardSection,
  tasks: renderWorkTaskSection,
  roadmap: renderWorkRoadmapSection
};

/**
 * @param {string} section
 * @returns {section is keyof typeof WORK_VIEW_SECTION_RENDERERS}
 */
export function isWorkViewSection(section) {
  return Object.hasOwn(WORK_VIEW_SECTION_RENDERERS, section);
}

/**
 * @param {string} section
 * @returns {(typeof WORK_VIEW_SECTION_RENDERERS)[keyof typeof WORK_VIEW_SECTION_RENDERERS] | null}
 */
export function workViewSectionRenderer(section) {
  if (!isWorkViewSection(section)) return null;
  return WORK_VIEW_SECTION_RENDERERS[section] ?? null;
}
