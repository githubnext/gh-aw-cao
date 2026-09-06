/**
 * Shared declarative workflow-route page primitives.
 */

import { workflowRouteComposition } from './workflow-route-composition.js';
import { renderWorkflowRouteShell } from './workflow-route-shell.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  return renderWorkflowRouteShell(context, workflowRouteComposition(context.elementConfig?.body));
}
