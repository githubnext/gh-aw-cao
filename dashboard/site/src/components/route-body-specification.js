/**
 * Shared Dashboard Language config.body values for route-bound elements.
 */

import campaignRouteNavigation from './campaign-route-navigation.json' with { type: 'json' };

export const WORKFLOW_ROUTE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const WORKFLOW_ROUTE_PAGE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const CAMPAIGN_ROUTE_TABS = Object.freeze(campaignRouteNavigation.tabs);
export const CAMPAIGN_ROUTE_DEFAULT_BODY = campaignRouteNavigation.default;
export const CAMPAIGN_ROUTE_ALIASES = Object.freeze(campaignRouteNavigation.aliases);
export const CAMPAIGN_ROUTE_BODY_VALUES = Object.freeze([
  ...CAMPAIGN_ROUTE_TABS.map((tab) => tab.id),
  ...campaignRouteNavigation['additional-bodies'],
  ...Object.keys(CAMPAIGN_ROUTE_ALIASES)
]);
export const OUTCOME_DETAIL_SECTION_BODY_VALUES = ['discussion', 'metadata'];
export const CAMPAIGN_ROUTE_VARIANT_VALUES = CAMPAIGN_ROUTE_BODY_VALUES;
export const WORK_VIEW_BODY_VALUES = ['board', 'tasks', 'roadmap'];
export const WORK_VIEW_SECTION_KEYS = ['board', 'tasks', 'roadmap'];
