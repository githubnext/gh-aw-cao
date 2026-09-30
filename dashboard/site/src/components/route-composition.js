/**
 * Shared route-bound element composition selection helpers.
 */

import { createDebug } from '../debug.js';

const debugRouteComposition = createDebug('route-composition');

/**
 * @template {string} T
 * @template V
 * @param {Readonly<Record<T, V>>} compositions
 * @param {unknown} selected
 * @param {T} fallback
 * @returns {V}
 */
export function selectNamedComposition(compositions, selected, fallback) {
  const key = typeof selected === 'string' && Object.hasOwn(compositions, selected)
    ? /** @type {T} */ (selected)
    : fallback;
  return compositions[key];
}

/**
 * Marks `root` as a route-bound view for `routeParameter`, wires the shared
 * `dashboard-route-change` listener that re-renders it whenever that
 * parameter's value changes, and performs the initial render with an empty
 * route value. Shared by {@link import('./route-empty-state.js').createRouteView}
 * and {@link import('./route-tabs.js').renderDeclaredRouteTabs}, which both
 * duplicated this route-value binding around otherwise different rendering.
 * @param {HTMLElement} root
 * @param {string | undefined} routeParameter
 * @param {(routeValue: string) => void} render
 */
export function bindRouteChangeListener(root, routeParameter, render) {
  root.dataset.routeView = '';
  if (routeParameter !== undefined) root.dataset.routeParameter = routeParameter;
  root.addEventListener('dashboard-route-change', (event) => {
    if (!(event instanceof CustomEvent) || event.detail?.parameter !== routeParameter) {
      debugRouteComposition({ event: 'change-ignored', routeParameter });
      return;
    }
    debugRouteComposition({ event: 'change-applied', routeParameter, hasValue: Boolean(event.detail.value) });
    render(event.detail.value);
  });
  debugRouteComposition({ event: 'bound', routeParameter });
  render('');
}
