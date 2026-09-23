/**
 * Shared route page shell primitives for declarative route compositions.
 */

import { h } from '../dom.js';
import { createRouteView } from './route-empty-state.js';
import { renderRouteTabSet } from './route-tab-set.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string, count?: number, trailingIcon?: string }} RoutePageTab
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
 *   pageLevelTabs?: boolean,
 *   renderMatched: RoutePageMatchRenderer
 * }} RoutePageShellOptions
 *
 * `pageLevelTabs` promotes persistent tabs into the nearest dashboard page
 * before its filter bar and removes them when the owning route view detaches.
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {RoutePageShellOptions} options
 * @returns {HTMLElement}
 */
export function createRoutePageShell(context, options) {
  let routeTitle = '';
  /** @type {HTMLElement | null} */
  let promotedTabs = null;
  /** @type {MutationObserver | null} */
  let pageObserver = null;
  /** @type {HTMLElement | null} */
  let observedPage = null;
  /** @type {HTMLElement} */
  let root;
  root = createRouteView({
    rootClassName: options.rootClassName,
    routeParameter: context.routeParameter ?? options.routeParameter,
    datasetKey: options.datasetKey,
    selectMessage: options.selectMessage,
    notFoundMessage: options.notFoundMessage,
    unavailableMessage: options.unavailableMessage,
    isUnavailable: options.isUnavailable,
    hasSelection: options.hasSelection,
    onRender: (routeValue, matched) => {
      if (!options.pageLevelTabs || !root) return;
      const hasSelection = options.hasSelection ? options.hasSelection(routeValue) : routeValue.trim().length > 0;
      const title = matched ? routeTitle : routeValue;
      const tabs = hasSelection
        ? renderRouteTabSet({
          className: options.tabListClassName,
          ariaLabel: options.tabListAriaLabel(title, routeValue),
          currentTab: options.currentTab,
          tabs: typeof options.tabs === 'function'
            ? options.tabs({ routeValue, title })
            : options.tabs
        })
        : null;
      root.querySelector(':scope > [data-route-tabs]')?.remove();
      promotedTabs?.remove();
      promotedTabs = null;
      const pageElement = root.closest('.dashboard-page');
      const page = pageElement instanceof HTMLElement ? pageElement : null;
      if (tabs && page) {
        page.insertBefore(tabs, page.querySelector(':scope > .filter-bar'));
        promotedTabs = tabs;
        if (observedPage !== page) {
          pageObserver?.disconnect();
          observedPage = page;
          pageObserver = new MutationObserver(() => {
            if (root.isConnected) return;
            promotedTabs?.remove();
            promotedTabs = null;
            pageObserver?.disconnect();
            pageObserver = null;
            observedPage = null;
          });
          pageObserver.observe(page, { childList: true });
        }
      } else if (tabs) {
        root.prepend(tabs);
      }
      routeTitle = '';
    },
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
      if (options.pageLevelTabs) return h('div', null, match.content);
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
