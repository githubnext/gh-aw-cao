/**
 * Declarative campaign route element compatibility wrapper.
 */

import { renderCampaignRouteVariant } from './campaign-route-view.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderCampaignNavigation(context) {
  return renderCampaignRouteVariant(context, 'overview');
}
