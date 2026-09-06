/**
 * Shared declarative workflow-route page primitives.
 */

import { workflowRouteComposition, workflowRouteCompositionForPage } from './workflow-route-composition.js';
import { renderWorkflowRouteShell } from './workflow-route-shell.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  return renderWorkflowRouteShell(
    context,
    context.elementConfig?.body
      ? workflowRouteComposition(context.elementConfig.body)
      : workflowRouteCompositionForPage(context.pageId)
  );
}
