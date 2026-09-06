/**
 * Shared declarative workflow-route page primitives.
 */

import { workflowRouteComposition } from './workflow-route-composition.js';
import { renderWorkflowRouteShell } from './workflow-route-shell.js';
import { workflowRoutePageConfig } from './workflow-route-page-config.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  const body = context.elementConfig?.body ?? workflowRoutePageConfig(context.pageId).body;
  return renderWorkflowRouteShell(context, workflowRouteComposition(body));
}
