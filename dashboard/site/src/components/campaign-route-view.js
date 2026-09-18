/**
 * Declarative campaign route view composition primitives.
 */

import { campaignRouteComposition } from './campaign-route-composition.js';
import { renderCampaignRouteShell } from './campaign-route-shell.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderCampaignRouteView(context) {
  return renderCampaignRouteShell(context, campaignRouteComposition(context.elementConfig?.body));
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {'overview'|'workflows'|'runs'|'issues'|'pull-requests'|'repositories'|'insights'|'reports'|'dispatches'} variant
 * @returns {HTMLElement}
 */
export function renderCampaignRouteVariant(context, variant) {
  return renderCampaignRouteShell(context, campaignRouteComposition(variant));
}
