/**
 * Declarative experiment view composition primitives.
 */

import { EXPERIMENTS_VIEW_BODY_VALUES } from './route-body-specification.js';
import { isExperimentViewSection } from './experiment-view-sections.js';

export { EXPERIMENTS_VIEW_BODY_VALUES };

/**
 * @typedef {{ section: 'overview'|'table'|'detail' }} ExperimentViewSection
 */

/**
 * @param {unknown} selected
 * @returns {ExperimentViewSection[]}
 */
export function experimentsViewComposition(selected) {
  if (Array.isArray(selected)) {
    const sections = selected
      .filter(isExperimentViewSection)
      .map((section) => /** @type {ExperimentViewSection} */ ({ section }));
    return sections.length > 0 ? sections : defaultExperimentViewComposition();
  }
  if (typeof selected !== 'string' || !EXPERIMENTS_VIEW_BODY_VALUES.includes(selected)) {
    return defaultExperimentViewComposition();
  }
  return [/** @type {ExperimentViewSection} */ ({ section: selected })];
}

/**
 * @returns {ExperimentViewSection[]}
 */
export function defaultExperimentViewComposition() {
  return [{ section: 'overview' }, { section: 'table' }, { section: 'detail' }];
}
