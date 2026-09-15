/**
 * Shared tab navigation for route-scoped detail pages.
 */

import { renderLinkTabs } from './tab-nav.js';

/**
 * @typedef {{ id: string, label: string, icon: string, href: string }} RouteTab
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
  return renderLinkTabs({
    className: options.className,
    ariaLabel: options.ariaLabel,
    tabs: options.tabs.map((tab) => ({
      label: tab.label,
      icon: tab.icon,
      href: tab.href,
      current: tab.id === options.currentTab
    }))
  });
}
