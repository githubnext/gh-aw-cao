/**
 * Declarative workflow route element compatibility wrapper.
 */

import { renderWorkflowRouteView } from './workflow-route-view.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowDetail(context) {
  return renderWorkflowRouteView(context);
}
