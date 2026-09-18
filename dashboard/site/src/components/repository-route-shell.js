/**
 * Shared repository-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { text } from './count-formatters.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizeRepositoryRoute } from './repository-route-composition.js';
import { REPOSITORY_ROUTE_TABS } from './route-body-specification.js';

/**
 * @typedef {import('./repository-route-composition.js').RepositoryRouteComposition} RepositoryRouteComposition
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {RepositoryRouteComposition} config
 * @returns {HTMLElement}
 */
export function renderRepositoryRouteShell(context, config) {
  const activityRows = rowsFor(context.sources, 'repository-activity');
  return createRoutePageShell(context, {
    rootClassName: config.rootClassName,
    datasetKey: 'repository',
    selectMessage: config.selectMessage,
    notFoundMessage: 'Repository not found.',
    hasSelection: (routeValue) => normalizeRepositoryRoute(routeValue).length > 0,
    currentTab: config.currentTab,
    tabListClassName: 'repository-tabs',
    tabListAriaLabel: (title) => `${title} views`,
    tabs: ({ routeValue }) => repositoryTabs(normalizeRepositoryRoute(routeValue)),
    renderMatched: (routeValue) => {
      const repository = normalizeRepositoryRoute(routeValue);
      if (!repository) return null;
      const activity = activityRows
        .find((row) => text(row.repository).toLowerCase() === repository.toLowerCase()) ?? {};
      return {
        allocation: {
          title: repository,
          description: config.description.replace('{repository}', repository),
          navigationPage: 'repositories'
        },
        content: config.bodyRenderer?.({ context, repository, activity }) ?? null
      };
    }
  });
}

/**
 * @param {string} repository
 */
function repositoryTabs(repository) {
  if (!repository) return [];
  const repositoryQuery = `?repository=${encodeURIComponent(repository)}`;
  return REPOSITORY_ROUTE_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    href: `#page-${tab.page}${repositoryQuery}`
  }));
}
