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
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {ExperimentViewSection[]}
 */
export function experimentsViewComposition(config) {
  if (Array.isArray(config?.sections)) {
    const sections = config.sections
      .filter(isExperimentViewSection)
      .map((section) => /** @type {ExperimentViewSection} */ ({ section }));
    return sections.length > 0 ? sections : defaultExperimentViewComposition();
  }
  if (typeof config?.body !== 'string' || !EXPERIMENTS_VIEW_BODY_VALUES.includes(config.body)) {
    return defaultExperimentViewComposition();
  }
  return [/** @type {ExperimentViewSection} */ ({ section: config.body })];
}

/**
 * @returns {ExperimentViewSection[]}
 */
export function defaultExperimentViewComposition() {
  return [{ section: 'overview' }, { section: 'table' }, { section: 'detail' }];
}
