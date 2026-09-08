/**
 * Shared declarative workflow-route page primitives.
 */

import { workflowRouteBody, workflowRouteComposition } from './workflow-route-composition.js';
import { renderWorkflowRouteShell } from './workflow-route-shell.js';
import { workflowRoutePageConfigForBody } from './workflow-route-page-config.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  const routePage = workflowRoutePageConfigForBody(context.elementConfig?.body);
  const body = workflowRouteBody(routePage.body);
  return renderWorkflowRouteShell(context, {
    ...workflowRouteComposition(body),
    currentTab: routePage.pageId
  });
}
