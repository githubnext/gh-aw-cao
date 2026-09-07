/**
 * Shared workflow-route-page body normalization for declarative route views.
 */

import { selectConfigBody } from './route-body-composition.js';
import { WORKFLOW_ROUTE_TAB_VALUES } from './route-body-specification.js';

export const WORKFLOW_ROUTE_PAGE_BODY_CONFIG = {
  values: /** @type {readonly ('insights'|'reports'|'runs')[]} */ (WORKFLOW_ROUTE_TAB_VALUES),
  fallback: /** @type {'insights'|'reports'|'runs'} */ ('reports')
};

/**
 * @param {unknown} body
 * @returns {'insights'|'reports'|'runs'}
 */
export function workflowRoutePageBody(body) {
  return selectConfigBody(WORKFLOW_ROUTE_PAGE_BODY_CONFIG, body);
}
