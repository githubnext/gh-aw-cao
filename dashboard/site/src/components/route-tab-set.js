/**
 * Shared tab navigation for route-scoped detail pages.
 */

import { renderLinkTabs } from './tab-nav.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string, count?: number, trailingIcon?: string, routeTitle?: string, routeDescription?: string }} RouteTab
 */

/**
 * @param {{
 *   className: string,
 *   ariaLabel: string,
 *   currentTab: string,
 *   tabs: RouteTab[]
 * }} options
 * @returns {HTMLElement}
 */
export function renderRouteTabSet(options) {
  const tabs = renderLinkTabs({
    className: options.className,
    ariaLabel: options.ariaLabel,
    tabs: options.tabs.map((tab) => ({
      label: tab.label,
      icon: tab.icon,
      href: tab.href,
      count: tab.count,
      trailingIcon: tab.trailingIcon,
      current: tab.id === options.currentTab
    }))
  });
  tabs.dataset.routeTabs = '';
  tabs.dataset.routeTabsCurrent = options.currentTab;
  for (const [index, link] of [...tabs.querySelectorAll('a')].entries()) {
    const tab = options.tabs[index];
    if (tab?.routeTitle) link.dataset.routeTitle = tab.routeTitle;
    if (tab?.routeDescription) link.dataset.routeDescription = tab.routeDescription;
    const route = link.getAttribute('href')?.split('?', 1)[0] ?? '';
    if (route.startsWith('#page-')) link.dataset.navPageId = decodeURIComponent(route.slice('#page-'.length));
  }
  return tabs;
}
