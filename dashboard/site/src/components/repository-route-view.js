/**
 * Declarative repository route view composition primitives.
 */

import { repositoryRouteComposition } from './repository-route-composition.js';
import { renderRepositoryRouteShell } from './repository-route-shell.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderRepositoryRouteView(context) {
  return renderRepositoryRouteShell(context, repositoryRouteComposition(context.elementConfig?.body));
}
