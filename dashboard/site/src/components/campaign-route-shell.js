/**
 * Shared campaign-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizeCampaignRoute, campaignNameForRoute } from './campaign-route-composition.js';
import { CAMPAIGN_ROUTE_TABS } from './route-body-specification.js';
import { renderEmptyMessage } from './ui-primitives.js';

const CAMPAIGN_TAB_COUNT_SOURCES = Object.freeze({
  insights: 'campaign-insight-tab-counts',
  problems: 'campaign-problem-tab-counts',
  issues: 'campaign-issue-tab-counts'
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
        const workflowsSource = context.sources.workflows;
        const stillCollecting = workflowsSource?.metadata?.availability !== 'unavailable'
          && workflowsSource?.metadata?.completeness !== 'complete';
        if (stillCollecting) {
          const campaignName = campaignNameForRoute(campaignId, workflows);
          return {
            allocation: {
              title: campaignName,
              description: config.description.replace('{campaignName}', campaignName),
              navigationPage: 'campaigns'
            },
            content: renderEmptyMessage('Loading campaign data...', {
              role: 'status',
              'aria-busy': 'true'
            })
          };
        }
        return null;
      }
      const campaignName = campaignNameForRoute(campaignId, workflows);
      return {
        allocation: {
          title: campaignName,
          description: config.description.replace('{campaignName}', campaignName),
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
  return Object.fromEntries(Object.entries(CAMPAIGN_TAB_COUNT_SOURCES).map(([tabId, sourceName]) => {
    const row = rowsFor(sources, sourceName)
      .find((candidate) => String(candidate.campaign).toLowerCase() === campaignId.toLowerCase());
    const count = Number(row?.items);
    return [tabId, Number.isFinite(count) && count > 0 ? count : 0];
  }));
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
