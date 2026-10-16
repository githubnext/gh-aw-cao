/**
 * Declarative route tabs for custom pages that declare `route.tabs`.
 */

import { h } from '../dom.js';
import { render, state } from '../reactive.js';
import { renderRouteTabSet } from './route-tab-set.js';
import { bindRouteChangeListener } from './route-composition.js';
import { createDebug } from '../debug.js';

const debugRouteTabs = createDebug('route-tabs');

/**
 * @typedef {{ id: string, label: string, icon: string, page: string }} DeclaredRouteTab
 */

/**
 * Renders the tab set declared by a routed custom page. The tabs stay hidden until a
 * route value is bound, and every tab href carries the current route value.
 * @param {{
 *   routeParameter: string,
 *   currentTab: string,
 *   tabs: DeclaredRouteTab[],
 *   className?: string
 * }} options
 * @returns {HTMLElement}
 */
export function renderDeclaredRouteTabs(options) {
  const root = h('div', { className: 'route-tab-navigation' });

  const routeValue = state('');

  render(root, () => {
    const value = routeValue.get();
    root.dataset.routeValue = value;
    if (!value) {
      debugRouteTabs({ event: 'cleared', parameter: options.routeParameter });
      return null;
    }

    const query = `?${encodeURIComponent(options.routeParameter)}=${encodeURIComponent(value)}`;
    debugRouteTabs({ event: 'rendered', parameter: options.routeParameter, tabCount: options.tabs.length, currentTab: options.currentTab });
    return renderRouteTabSet({
      className: options.className ?? 'route-tabs',
      ariaLabel: `${value} views`,
      currentTab: options.currentTab,
      tabs: options.tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        icon: tab.icon,
        href: `#page-${encodeURIComponent(tab.page)}${query}`
      }))
    });
  });

  bindRouteChangeListener(root, options.routeParameter, (value) => routeValue.set(value.trim()));
  return root;
}

/**
 * Renders declared tabs whose destinations are dashboard pages rather than
 * values of a route-bound entity.
 * @param {{ currentTab: string, tabs: DeclaredRouteTab[], className?: string }} options
 */
export function renderPageTabs(options) {
  return h('div', { className: 'route-tab-navigation' }, renderRouteTabSet({
    className: options.className ?? 'route-tabs',
    ariaLabel: 'Page views',
    currentTab: options.currentTab,
    tabs: options.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
      href: `#page-${encodeURIComponent(tab.page)}`
    }))
  }));
}

/**
 * Reads the declared tabs of a custom page route.
 * @param {unknown} route
 * @returns {{ tabs: DeclaredRouteTab[], currentTab: string, className?: string } | null}
 */
export function declaredRouteTabs(route) {
  if (route === null || typeof route !== 'object') return null;
  const definition = /** @type {Record<string, unknown>} */ (route);
  const tabs = Array.isArray(definition.tabs)
    ? definition.tabs.filter((tab) => (
      tab !== null
      && typeof tab === 'object'
      && ['id', 'label', 'icon', 'page'].every((key) => typeof (/** @type {Record<string, unknown>} */ (tab))[key] === 'string')
    ))
    : [];
  if (tabs.length === 0) {
    debugRouteTabs({ event: 'declared-tabs-empty' });
    return null;
  }
  debugRouteTabs({ event: 'declared-tabs-parsed', tabCount: tabs.length });
  return {
    tabs: /** @type {DeclaredRouteTab[]} */ (tabs),
    currentTab: typeof definition.tab === 'string' ? definition.tab : '',
    ...(typeof definition['tabs-class-name'] === 'string'
      ? { className: definition['tabs-class-name'] }
      : {})
  };
}
