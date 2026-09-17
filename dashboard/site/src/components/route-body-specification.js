/**
 * Shared Dashboard Language config.body values for route-bound elements.
 */

export const WORKFLOW_ROUTE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const WORKFLOW_ROUTE_PAGE_BODY_VALUES = ['insights', 'reports', 'runs'];
export const PACKAGE_ROUTE_TABS = Object.freeze([
  { id: 'overview', label: 'Overview', icon: 'package', page: 'package-detail' },
  { id: 'issues', label: 'Issues', icon: 'issue-opened', page: 'package-issues' },
  { id: 'pull-requests', label: 'Pull requests', icon: 'git-pull-request', page: 'package-pull-requests' },
  { id: 'runs', label: 'Actions', icon: 'play', page: 'package-runs' },
  { id: 'repositories', label: 'Repositories', icon: 'repo', page: 'package-repositories' },
  { id: 'insights', label: 'Insights', icon: 'graph', page: 'package-insights' },
  { id: 'reports', label: 'Reports', icon: 'file', page: 'package-reports' }
]);
export const PACKAGE_ROUTE_BODY_VALUES = PACKAGE_ROUTE_TABS.map((tab) => tab.id);
export const OUTCOME_DETAIL_SECTION_BODY_VALUES = ['discussion', 'metadata'];
export const PACKAGE_ROUTE_VARIANT_VALUES = PACKAGE_ROUTE_BODY_VALUES;
export const WORK_VIEW_BODY_VALUES = ['board', 'tasks', 'roadmap'];
export const WORK_VIEW_SECTION_KEYS = ['board', 'tasks', 'roadmap'];
