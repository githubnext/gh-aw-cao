/**
 * Shared declarative workflow-route page primitives.
 */

import { renderWorkflowRouteView } from './workflow-route-view.js';

/**
 * Renders the `workflow-route-page` element type. Identical in behavior to
 * `renderWorkflowRouteView`; kept as a distinct export because both element
 * types are registered separately in the `ui-elements.js` dispatch table.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRoutePage(context) {
  return renderWorkflowRouteView(context);
}
