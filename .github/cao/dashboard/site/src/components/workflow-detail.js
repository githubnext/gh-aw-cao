/**
 * Declarative workflow route element compatibility wrapper.
 */

import { renderWorkflowRoutePage } from './workflow-route-page.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowDetail(context) {
  return renderWorkflowRoutePage(context);
}
