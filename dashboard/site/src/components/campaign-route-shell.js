/**
 * Shared campaign-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizeCampaignRoute, campaignModeForRoute, campaignNameForRoute } from './campaign-route-composition.js';
import { CAMPAIGN_ROUTE_TABS } from './route-body-specification.js';

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: 'overview'|'workflows'|'runs'|'issues'|'pull-requests'|'repositories'|'insights'|'problems'|'reports',
 *   bodyRenderer: CampaignRouteBodyRenderer | undefined
 * }} CampaignRouteShellConfig
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   campaignId: string,
 *   campaignName: string,
 *   workflows: Array<Record<string, unknown>>
 * }) => HTMLElement | null} CampaignRouteBodyRenderer
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {CampaignRouteShellConfig} config
 * @returns {HTMLElement}
 */
export function renderCampaignRouteShell(context, config) {
  const allWorkflows = rowsFor(context.sources, 'workflows');
  return createRoutePageShell(context, {
    rootClassName: config.rootClassName,
    datasetKey: 'campaign',
    selectMessage: config.selectMessage,
    notFoundMessage: 'Campaign not found.',
    unavailableMessage: 'Campaign data is unavailable.',
    isUnavailable: () => context.sources.workflows?.metadata?.availability === 'unavailable',
    hasSelection: (routeValue) => normalizeCampaignRoute(routeValue).length > 0,
    currentTab: config.currentTab,
    tabListClassName: 'campaign-tabs',
    tabListAriaLabel: (title) => `${title} views`,
    tabs: ({ routeValue }) => campaignTabs(routeValue),
    renderMatched: (routeValue) => {
      const campaignId = normalizeCampaignRoute(routeValue);
      const workflows = allWorkflows
        .filter((workflow) => campaignId && String(workflow.campaign).toLowerCase() === campaignId.toLowerCase());
      if (workflows.length === 0) {
        return null;
      }
      const campaignName = campaignNameForRoute(campaignId, workflows);
      return {
        allocation: {
          title: campaignName,
          description: config.description.replace('{campaignName}', campaignName),
          mode: campaignModeForRoute(workflows),
          navigationPage: 'campaigns'
        },
        content: config.bodyRenderer?.({ context, campaignId, campaignName, workflows }) ?? null
      };
    }
  });
}

/**
 * @param {string} campaignId
 */
function campaignTabs(campaignId) {
  const campaignQuery = `?campaign=${encodeURIComponent(campaignId)}`;
  return CAMPAIGN_ROUTE_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    href: `#page-${tab.page}${campaignQuery}`,
    trailingIcon: 'chevron-right'
  }));
}
