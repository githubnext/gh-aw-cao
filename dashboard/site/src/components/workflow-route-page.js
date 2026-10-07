/**
 * Shared declarative workflow-route page primitives.
 */

import { workflowRouteBody, workflowRouteComposition } from './workflow-route-composition.js';
import { renderWorkflowRouteShell } from './workflow-route-shell.js';
import { workflowRoutePageConfigForBody } from './workflow-route-page-config.js';
import { createDebug } from '../debug.js';

const debugWorkflowRoutePage = createDebug('workflow-route-page');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  const requestedBody = context.elementConfig?.body;
  const body = workflowRouteBody(requestedBody);
  const pageId = workflowRoutePageConfigForBody(body).pageId;
  debugWorkflowRoutePage({
    event: 'render',
    requestedBody: typeof requestedBody === 'string' ? requestedBody : 'unset',
    resolvedBody: body,
    pageId
  });
  return renderWorkflowRouteShell(context, {
    ...workflowRouteComposition(body),
    currentTab: pageId
  });
}
