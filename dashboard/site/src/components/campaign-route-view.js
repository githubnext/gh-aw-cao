/**
 * Declarative campaign route view composition primitives.
 */

import { campaignRouteComposition } from './campaign-route-composition.js';
import { renderCampaignRouteShell } from './campaign-route-shell.js';
import { createDebug } from '../debug.js';

const debugCampaignRouteView = createDebug('campaign-route-view');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderCampaignRouteView(context) {
  const body = context.elementConfig?.body;
  debugCampaignRouteView({
    event: 'render',
    bodySource: 'element-config',
    body: typeof body === 'string' ? body : 'unset'
  });
  return renderCampaignRouteShell(context, campaignRouteComposition(body));
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {'overview'|'workflows'|'runs'|'issues'|'repositories'|'insights'|'problems'|'reports'|'memory'|'dispatches'} variant
 * @returns {HTMLElement}
 */
export function renderCampaignRouteVariant(context, variant) {
  debugCampaignRouteView({ event: 'render', bodySource: 'explicit-variant', body: variant });
  return renderCampaignRouteShell(context, campaignRouteComposition(variant));
}
