/**
 * Shared route page shell primitives for declarative route compositions.
 */

import { h } from '../dom.js';
import { createRouteView } from './route-empty-state.js';
import { renderRouteTabSet } from './route-tab-set.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string, trailingIcon?: string }} RoutePageTab
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
  let routeTitle = '';
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
      routeTitle = title;
      root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
        bubbles: true,
        detail: allocation
      }));
      return h('div', null, match.content);
    }
  });
  root.addEventListener('dashboard-route-change', (event) => {
    if (!(event instanceof CustomEvent) || event.detail?.parameter !== (context.routeParameter ?? options.routeParameter)) return;
    const routeValue = typeof event.detail.value === 'string' ? event.detail.value : '';
    const hasSelection = options.hasSelection ? options.hasSelection(routeValue) : routeValue.trim().length > 0;
    const tabs = hasSelection
      ? renderRouteTabSet({
        className: options.tabListClassName,
        ariaLabel: options.tabListAriaLabel(routeTitle || routeValue, routeValue),
        currentTab: options.currentTab,
        tabs: typeof options.tabs === 'function'
          ? options.tabs({ routeValue, title: routeTitle })
          : options.tabs
      })
      : null;
    root.querySelector(':scope > [data-route-tabs]')?.remove();
    const page = root.closest('.dashboard-page');
    const pageTabs = page?.querySelector(':scope > [data-route-tabs]');
    pageTabs?.remove();
    if (tabs && page) {
      page.insertBefore(tabs, page.querySelector(':scope > .filter-bar'));
    } else if (tabs) {
      root.prepend(tabs);
    }
    routeTitle = '';
  });
  return root;
}
