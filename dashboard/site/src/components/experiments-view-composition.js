/**
 * Declarative experiment view composition primitives.
 */

import { selectConfigBody } from './route-body-composition.js';

export const EXPERIMENTS_VIEW_BODY_VALUES = ['overview', 'table', 'detail'];

/**
 * @typedef {{ section: 'overview'|'table'|'detail' }} ExperimentViewSection
 */

/**
 * @param {unknown} selected
 * @returns {ExperimentViewSection[]}
 */
export function experimentsViewComposition(selected) {
  const body = selectConfigBody(
    { values: EXPERIMENTS_VIEW_BODY_VALUES, fallback: 'detail' },
    selected
  );
  if (body === 'overview') return [{ section: 'overview' }];
  if (body === 'table') return [{ section: 'table' }];
  return [{ section: 'overview' }, { section: 'table' }, { section: 'detail' }];
}
