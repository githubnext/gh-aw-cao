/**
 * Declarative experiment view composition primitives.
 */

import { EXPERIMENTS_VIEW_BODY_VALUES } from './route-body-specification.js';

export { EXPERIMENTS_VIEW_BODY_VALUES };

/**
 * @typedef {{ section: 'overview'|'table'|'detail' }} ExperimentViewSection
 */

/**
 * @param {unknown} selected
 * @returns {ExperimentViewSection[]}
 */
export function experimentsViewComposition(selected) {
  if (typeof selected !== 'string' || !EXPERIMENTS_VIEW_BODY_VALUES.includes(selected)) {
    return [{ section: 'overview' }, { section: 'table' }, { section: 'detail' }];
  }
  if (selected === 'overview') return [{ section: 'overview' }];
  if (selected === 'table') return [{ section: 'table' }];
  return [{ section: 'detail' }];
}
