/**
 * Shared package-route shell primitives for declarative composition.
 */

import { rowsFor } from './source-rows.js';
import { createRoutePageShell } from './route-page-shell.js';
import { normalizePackageRoute, packageModeForRoute, packageNameForRoute } from './package-route-composition.js';

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: 'insights'|'workflows'|'dispatches'|'reports',
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
  return [
    { id: 'insights', label: 'Insights', icon: 'graph', href: `#page-package-insights${packageQuery}` },
    { id: 'workflows', label: 'Workflows', icon: 'workflow', href: `#page-package-detail${packageQuery}` },
    { id: 'dispatches', label: 'Dispatches', icon: 'play', href: `#page-package-dispatches${packageQuery}` },
    { id: 'reports', label: 'Reports', icon: 'issue', href: `#page-package-reports${packageQuery}` }
  ];
}
