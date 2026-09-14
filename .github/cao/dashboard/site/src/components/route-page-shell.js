/**
 * Shared route page shell primitives for declarative route compositions.
 */

import { h } from '../dom.js';
import { createRouteView } from './route-empty-state.js';
import { renderRouteTabSet } from './route-tab-set.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string }} RoutePageTab
 */

/**
 * @typedef {(routeValue: string, root: HTMLElement) => {
 *   allocation: Record<string, unknown>,
 *   content: HTMLElement | null
 * } | null} RoutePageMatchRenderer
 */

/**
 * @typedef {{
 *   rootClassName: string,
 *   routeParameter?: string,
 *   datasetKey: string,
 *   selectMessage: string,
 *   notFoundMessage: string,
 *   unavailableMessage?: string,
 *   isUnavailable?: () => boolean,
 *   hasSelection?: (routeValue: string) => boolean,
 *   currentTab: string,
 *   tabListClassName: string,
 *   tabListAriaLabel: (title: string, routeValue: string) => string,
 *   tabs: RoutePageTab[] | ((args: { routeValue: string, title: string }) => RoutePageTab[]),
 *   renderMatched: RoutePageMatchRenderer
 * }} RoutePageShellOptions
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {RoutePageShellOptions} options
 * @returns {HTMLElement}
 */
export function createRoutePageShell(context, options) {
  const root = createRouteView({
    rootClassName: options.rootClassName,
    routeParameter: context.routeParameter ?? options.routeParameter,
    datasetKey: options.datasetKey,
    selectMessage: options.selectMessage,
    notFoundMessage: options.notFoundMessage,
    unavailableMessage: options.unavailableMessage,
    isUnavailable: options.isUnavailable,
    hasSelection: options.hasSelection,
    renderMatched: (routeValue) => {
      const match = options.renderMatched(routeValue, root);
      if (!match) return null;
      const allocation = match.allocation;
      const title = typeof allocation.title === 'string' ? allocation.title : '';
      root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
        bubbles: true,
        detail: allocation
      }));
      const tabs = typeof options.tabs === 'function'
        ? options.tabs({ routeValue, title })
        : options.tabs;
      return h(
        'div',
        null,
        renderRouteTabSet({
          className: options.tabListClassName,
          ariaLabel: options.tabListAriaLabel(title, routeValue),
          currentTab: options.currentTab,
          tabs
        }),
        match.content
      );
    }
  });
  return root;
}
