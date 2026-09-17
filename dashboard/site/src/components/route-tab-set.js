/**
 * Shared tab navigation for route-scoped detail pages.
 */

import { renderLinkTabs } from './tab-nav.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string, trailingIcon?: string }} RouteTab
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
      trailingIcon: tab.trailingIcon,
      current: tab.id === options.currentTab
    }))
  });
  tabs.dataset.routeTabs = '';
  return tabs;
}
