/**
 * Reusable routed single-record detail view.
 *
 * Binds a route parameter to a single query result, dispatches the shared `dashboard-route-allocation` event
 * describing the matched record, and renders one of the select/not-found/
 * matched states through {@link createRouteView}. Domain-specific detail
 * views differ only in how they validate the result's route identity
 * and how they describe and render it; this primitive
 * captures the shared route-binding, debug-logging, and allocation-dispatch
 * control flow so each view supplies only that domain-specific behavior.
 */

import { createRouteView } from './route-empty-state.js';
import { createDebug } from '../debug.js';

/**
 * @typedef {{
 *   category: string,
 *   rootClassName: string,
 *   datasetKey: string,
 *   selectMessage: string,
 *   notFoundMessage: string,
 *   row: Record<string, unknown> | undefined,
 *   matches: (row: Record<string, unknown>, routeValue: string) => boolean,
 *   allocation: (row: Record<string, unknown>, routeValue: string) => Record<string, unknown>,
 *   renderContent: (row: Record<string, unknown>, routeValue: string) => HTMLElement
 * }} RouteDetailViewOptions
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {RouteDetailViewOptions} options
 * @returns {HTMLElement}
 */
export function renderRouteDetailView(context, options) {
  const debug = createDebug(options.category);
  debug({ event: 'initialized', pageId: context.pageId, rowCount: options.row ? 1 : 0 });
  /** @type {HTMLElement} */
  let root;
  root = createRouteView({
    rootClassName: options.rootClassName,
    routeParameter: context.routeParameter,
    datasetKey: options.datasetKey,
    selectMessage: options.selectMessage,
    notFoundMessage: options.notFoundMessage,
    renderMatched: (routeValue) => {
      const row = options.row;
      if (!row || !options.matches(row, routeValue)) {
        debug({ event: 'not-found', pageId: context.pageId });
        return null;
      }
      debug({ event: 'matched', pageId: context.pageId });
      root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
        bubbles: true,
        detail: options.allocation(row, routeValue)
      }));
      return options.renderContent(row, routeValue);
    }
  });
  return root;
}
