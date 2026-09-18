/**
 * Repository route composition registry shared by declarative route views.
 */

import { createRouteBodyConfig } from './route-body-config.js';
import { REPOSITORY_ROUTE_BODY_VALUES, REPOSITORY_ROUTE_DEFAULT_BODY } from './route-body-specification.js';
import { renderRepositoryOverview, renderRepositorySettings } from './repository-route-bodies.js';

/**
 * @typedef {'overview'|'insights'|'workflows'|'runs'|'settings'} RepositoryRouteBody
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   repository: string,
 *   activity: Record<string, unknown>
 * }) => HTMLElement | null} RepositoryRouteBodyRenderer
 */

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: RepositoryRouteBody,
 *   bodyRenderer: RepositoryRouteBodyRenderer | undefined
 * }} RepositoryRouteComposition
 */

/**
 * `description` supports the `{repository}` placeholder, replaced with the routed coordinate.
 * Tabs without a `bodyRenderer` render only the tab bar; their content comes from the
 * declarative table and chart views declared alongside the element on the same page.
 * @type {Readonly<Record<RepositoryRouteBody, RepositoryRouteComposition>>}
 */
const REPOSITORY_ROUTE_COMPOSITIONS = {
  overview: {
    rootClassName: 'repository-detail',
    selectMessage: 'Select a repository to view its overview.',
    description: 'Observed workflow health and AI Credit usage for {repository}.',
    currentTab: 'overview',
    bodyRenderer: ({ repository, activity }) => renderRepositoryOverview({ repository, activity })
  },
  insights: {
    rootClassName: 'repository-insights',
    selectMessage: 'Select a repository to view its insights.',
    description: 'Run health and execution trends observed for {repository}.',
    currentTab: 'insights',
    bodyRenderer: undefined
  },
  workflows: {
    rootClassName: 'repository-workflows',
    selectMessage: 'Select a repository to view its workflows.',
    description: 'Declared GitHub Agentic Workflows owned by {repository}.',
    currentTab: 'workflows',
    bodyRenderer: undefined
  },
  runs: {
    rootClassName: 'repository-runs',
    selectMessage: 'Select a repository to view its runs.',
    description: 'Observed GitHub Actions runs for the workflows in {repository}.',
    currentTab: 'runs',
    bodyRenderer: undefined
  },
  settings: {
    rootClassName: 'repository-settings',
    selectMessage: 'Select a repository to view its settings.',
    description: 'Agentic workflow maintenance actions for {repository}.',
    currentTab: 'settings',
    bodyRenderer: ({ repository }) => renderRepositorySettings({ repository })
  }
};

const REPOSITORY_ROUTE_BODY_CONFIG = createRouteBodyConfig(
  /** @type {readonly RepositoryRouteBody[]} */ (REPOSITORY_ROUTE_BODY_VALUES),
  /** @type {RepositoryRouteBody} */ (REPOSITORY_ROUTE_DEFAULT_BODY)
);

/**
 * @param {unknown} body
 * @returns {RepositoryRouteBody}
 */
export function repositoryRouteBody(body) {
  return REPOSITORY_ROUTE_BODY_CONFIG.body(body);
}

/**
 * @param {unknown} body
 * @returns {RepositoryRouteComposition}
 */
export function repositoryRouteComposition(body) {
  return /** @type {RepositoryRouteComposition} */ (
    REPOSITORY_ROUTE_BODY_CONFIG.composition(REPOSITORY_ROUTE_COMPOSITIONS, body)
  );
}

// GitHub owner names are 1-100 characters of alphanumerics or hyphens, and repository
// names are 1-100 characters of alphanumerics, hyphens, underscores, or periods.
const REPOSITORY_COORDINATE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Normalizes a repository route value into an `organization/repository` coordinate,
 * returning an empty string when the route value is not a valid coordinate.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRepositoryRoute(value) {
  if (typeof value !== 'string') return '';
  const repository = value.trim();
  return REPOSITORY_COORDINATE_PATTERN.test(repository) ? repository : '';
}
