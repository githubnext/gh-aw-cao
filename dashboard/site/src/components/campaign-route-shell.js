/**
 * Shared campaign-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizeCampaignRoute, campaignModeForRoute, campaignNameForRoute } from './campaign-route-composition.js';
import { CAMPAIGN_ROUTE_TABS } from './route-body-specification.js';

const CAMPAIGN_TAB_SOURCES = Object.freeze({
  insights: 'audit-events',
  problems: 'campaign-problem-items',
  runs: 'campaign-runs',
  issues: 'campaign-worker-issues'
});

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
    tabs: ({ routeValue }) => campaignTabs(routeValue, campaignTabCounts(routeValue, context.sources)),
    pageLevelTabs: true,
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
          ...(config.currentTab === 'problems' ? {} : { mode: campaignModeForRoute(workflows) }),
          navigationPage: 'campaigns'
        },
        content: config.bodyRenderer?.({ context, campaignId, campaignName, workflows }) ?? null
      };
    }
  });
}

/**
 * @param {string} campaignId
 * @param {import('./ui-elements.js').ElementRenderContext['sources']} sources
 */
function campaignTabCounts(campaignId, sources) {
  return Object.fromEntries(Object.entries(CAMPAIGN_TAB_SOURCES).map(([tabId, sourceName]) => [
    tabId,
    rowsFor(sources, sourceName)
      .filter((row) => String(row.campaign).toLowerCase() === campaignId.toLowerCase())
      .length
  ]));
}

/**
 * @param {string} campaignId
 * @param {Record<string, number>} counts
 */
function campaignTabs(campaignId, counts) {
  const campaignQuery = `?campaign=${encodeURIComponent(campaignId)}`;
  return CAMPAIGN_ROUTE_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    href: `#page-${tab.page}${campaignQuery}`,
    count: (counts[tab.id] ?? 0) > 0 ? counts[tab.id] : undefined,
    trailingIcon: 'chevron-right'
  }));
}
