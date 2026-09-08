/**
 * Shared work-project section composition helpers and renderer registry.
 */

/**
 * @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection
 */

/** @typedef {'board'|'tasks'|'roadmap'} WorkSectionKey */
/** @typedef {(items: Array<any>, section: WorkSection, onUpdate: () => void) => HTMLElement} WorkSectionRenderer */

/**
 * @param {string} pageId
 * @param {WorkSectionKey} key
 * @returns {string}
 */
export function workSectionId(pageId, key) {
  return `${pageId}-${key}`;
}

/**
 * @param {Record<WorkSectionKey, WorkSectionRenderer>} renderers
 * @returns {(filteredItems: Array<any>, sections: Array<{ key: WorkSectionKey, className: string, landmarkLabel: string, title: string }>, pageId: string, onUpdate: () => void) => HTMLElement[]}
 */
export function createWorkSectionCompositionRenderer(renderers) {
  return (filteredItems, sections, pageId, onUpdate) => sections
    .map((section) => renderers[section.key]?.(filteredItems, {
      id: workSectionId(pageId, section.key),
      className: section.className,
      landmarkLabel: section.landmarkLabel,
      title: section.title
    }, onUpdate) ?? null)
    .filter((element) => element instanceof HTMLElement);
}
