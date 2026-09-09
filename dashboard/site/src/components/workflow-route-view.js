/**
 * Declarative workflow route view composition primitives.
 */

import { workflowRouteBody, workflowRouteComposition } from './workflow-route-composition.js'
import { renderWorkflowRouteShell } from './workflow-route-shell.js'
import { workflowRoutePageConfigForBody } from './workflow-route-page-config.js'

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRouteView(context) {
  const body = workflowRouteBody(context.elementConfig?.body)
  return renderWorkflowRouteShell(context, {
    ...workflowRouteComposition(body),
    currentTab: workflowRoutePageConfigForBody(body).pageId,
  })
}
