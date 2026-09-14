/**
 * Declarative package route element compatibility wrapper.
 */

import { renderPackageRouteVariant } from './package-route-view.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderPackageNavigation(context) {
  return renderPackageRouteVariant(context, 'workflows');
}
