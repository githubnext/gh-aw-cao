/**
 * Shared Dashboard Language config.body values for route-bound elements.
 */

import campaignResourceNavigation from './campaign-resource-navigation.json' with { type: 'json' };

export const WORKFLOW_ROUTE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const WORKFLOW_ROUTE_PAGE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const CAMPAIGN_ROUTE_TABS = Object.freeze(campaignResourceNavigation.tabs);
export const CAMPAIGN_ROUTE_DEFAULT_BODY = campaignResourceNavigation.default;
export const CAMPAIGN_ROUTE_ALIASES = Object.freeze(campaignResourceNavigation.aliases);
export const CAMPAIGN_ROUTE_BODY_VALUES = Object.freeze([
  ...CAMPAIGN_ROUTE_TABS.map((tab) => tab.id),
  ...campaignResourceNavigation['additional-bodies'],
  ...Object.keys(CAMPAIGN_ROUTE_ALIASES)
]);
export const OUTCOME_DETAIL_SECTION_BODY_VALUES = ['discussion', 'metadata'];
export const CAMPAIGN_ROUTE_VARIANT_VALUES = CAMPAIGN_ROUTE_BODY_VALUES;
export const WORK_VIEW_BODY_VALUES = ['board', 'tasks', 'roadmap'];
export const WORK_VIEW_SECTION_KEYS = ['board', 'tasks', 'roadmap'];
