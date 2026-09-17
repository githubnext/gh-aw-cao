/**
 * Shared package-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizePackageRoute, packageModeForRoute, packageNameForRoute } from './package-route-composition.js';
import { PACKAGE_ROUTE_TABS } from './route-body-specification.js';

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: 'overview'|'workflows'|'runs'|'issues'|'pull-requests'|'repositories'|'insights'|'reports',
 *   bodyRenderer: PackageRouteBodyRenderer | undefined
 * }} PackageRouteShellConfig
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   packageId: string,
 *   packageName: string,
 *   workflows: Array<Record<string, unknown>>
 * }) => HTMLElement | null} PackageRouteBodyRenderer
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {PackageRouteShellConfig} config
 * @returns {HTMLElement}
 */
export function renderPackageRouteShell(context, config) {
  const allWorkflows = rowsFor(context.sources, 'workflows');
  return createRoutePageShell(context, {
    rootClassName: config.rootClassName,
    datasetKey: 'package',
    selectMessage: config.selectMessage,
    notFoundMessage: 'Package not found.',
    unavailableMessage: 'Package data is unavailable.',
    isUnavailable: () => context.sources.workflows?.metadata?.availability === 'unavailable',
    hasSelection: (routeValue) => normalizePackageRoute(routeValue).length > 0,
    currentTab: config.currentTab,
    tabListClassName: 'package-tabs',
    tabListAriaLabel: (title) => `${title} views`,
    tabs: ({ routeValue }) => packageTabs(routeValue),
    renderMatched: (routeValue) => {
      const packageId = normalizePackageRoute(routeValue);
      const workflows = allWorkflows
        .filter((workflow) => packageId && String(workflow.package).toLowerCase() === packageId.toLowerCase());
      if (workflows.length === 0) {
        return null;
      }
      const packageName = packageNameForRoute(packageId, workflows);
      return {
        allocation: {
          title: packageName,
          description: config.description.replace('{packageName}', packageName),
          mode: packageModeForRoute(workflows),
          navigationPage: 'packages'
        },
        content: config.bodyRenderer?.({ context, packageId, packageName, workflows }) ?? null
      };
    }
  });
}

/**
 * @param {string} packageId
 */
function packageTabs(packageId) {
  const packageQuery = `?package=${encodeURIComponent(packageId)}`;
  return PACKAGE_ROUTE_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    href: `#page-${tab.page}${packageQuery}`,
    trailingIcon: 'chevron-right'
  }));
}
