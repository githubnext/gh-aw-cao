/**
 * Shared Dashboard Language config.body values for route-bound elements.
 */

import packageResourceNavigation from './package-resource-navigation.json' with { type: 'json' };

export const WORKFLOW_ROUTE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const WORKFLOW_ROUTE_PAGE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const PACKAGE_ROUTE_TABS = Object.freeze(packageResourceNavigation.tabs);
export const PACKAGE_ROUTE_DEFAULT_BODY = packageResourceNavigation.default;
export const PACKAGE_ROUTE_ALIASES = Object.freeze(packageResourceNavigation.aliases);
export const PACKAGE_ROUTE_BODY_VALUES = Object.freeze([
  ...PACKAGE_ROUTE_TABS.map((tab) => tab.id),
  ...packageResourceNavigation['additional-bodies'],
  ...Object.keys(PACKAGE_ROUTE_ALIASES)
]);
export const OUTCOME_DETAIL_SECTION_BODY_VALUES = ['discussion', 'metadata'];
export const PACKAGE_ROUTE_VARIANT_VALUES = PACKAGE_ROUTE_BODY_VALUES;
export const WORK_VIEW_BODY_VALUES = ['board', 'tasks', 'roadmap'];
export const WORK_VIEW_SECTION_KEYS = ['board', 'tasks', 'roadmap'];
