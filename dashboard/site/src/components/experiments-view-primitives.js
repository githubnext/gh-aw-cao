/**
 * Shared declarative experiments-evaluation view composition primitives.
 */

import { EXPERIMENTS_VIEW_BODY_VALUES } from './route-body-specification.js'
import {
  createElementCompositionConfig,
  selectElementComposition,
} from './view-element-composition.js'

/** @typedef {'overview'|'table'|'detail'} ExperimentsViewBody */

const EXPERIMENTS_VIEW_CONFIG = createElementCompositionConfig(
  /** @type {readonly ExperimentsViewBody[]} */ (EXPERIMENTS_VIEW_BODY_VALUES),
  /** @type {ExperimentsViewBody} */ ('detail'),
)

/**
 * @typedef {{
 *   key: ExperimentsViewBody,
 *   className: string
 * }} ExperimentsViewComposition
 */

const EXPERIMENTS_VIEW_COMPOSITIONS =
  /** @type {Readonly<Record<ExperimentsViewBody, ExperimentsViewComposition>>} */ ({
    overview: { key: 'overview', className: 'experiment-overview' },
    table: { key: 'table', className: 'experiment-decision-table' },
    detail: { key: 'detail', className: 'experiment-detail' },
  })

/**
 * @param {unknown} body
 * @returns {ExperimentsViewComposition}
 */
export function experimentsViewCompositionForBody(body) {
  return selectElementComposition(
    EXPERIMENTS_VIEW_COMPOSITIONS,
    EXPERIMENTS_VIEW_CONFIG,
    body,
  )
}

/**
 * @returns {ExperimentsViewComposition[]}
 */
export function defaultExperimentsViewComposition() {
  return EXPERIMENTS_VIEW_BODY_VALUES.map((body) =>
    experimentsViewCompositionForBody(body),
  )
}
