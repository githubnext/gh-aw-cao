/**
 * Declarative workflow route view composition primitives.
 */

import { renderWorkflowRoutePage } from './workflow-route-page.js';

/**
 * Identical to {@link renderWorkflowRoutePage}; kept as a distinctly named
 * export because callers select between the "workflow-route" and
 * "workflow-route-page" declarative elements by name.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRouteView(context) {
  return renderWorkflowRoutePage(context);
}
