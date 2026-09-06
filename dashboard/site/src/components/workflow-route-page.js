/**
 * Shared declarative workflow-route page primitives.
 */

import { renderWorkflowRouteView } from './workflow-route-view.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  return renderWorkflowRouteView(context);
}
