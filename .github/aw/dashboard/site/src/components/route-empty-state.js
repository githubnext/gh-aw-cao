/**
 * Shared route-scoped empty and unavailable state helpers.
 */

import { h } from '../dom.js';
import { renderEmptyMessage } from './ui-primitives.js';

/**
 * @typedef {{
 *   rootClassName: string,
 *   routeParameter?: string,
 *   datasetKey: string,
 *   renderMatched: (routeValue: string) => HTMLElement | null,
 *   selectMessage: string,
 *   notFoundMessage: string,
 *   unavailableMessage?: string,
 *   isUnavailable?: () => boolean,
 *   hasSelection?: (routeValue: string) => boolean
 * }} RouteViewOptions
 */

/**
 * Creates a route-aware root element that renders one matched state or one of the
 * shared selection, not-found, or unavailable messages.
 * @param {RouteViewOptions} options
 * @returns {HTMLElement}
 */
export function createRouteView(options) {
  const root = h('div', {
    className: options.rootClassName,
    'data-route-view': '',
    'data-route-parameter': options.routeParameter
  });

  /** @param {unknown} routeValue */
  const render = (routeValue) => {
    const normalizedValue = typeof routeValue === 'string' ? routeValue : '';
    root.dataset[options.datasetKey] = normalizedValue;
    const unavailable = options.isUnavailable?.() ?? false;
    const hasSelection = options.hasSelection ? options.hasSelection(normalizedValue) : normalizedValue.trim().length > 0;
    const matched = unavailable || !hasSelection ? null : options.renderMatched(normalizedValue);
    const message = unavailable
      ? options.unavailableMessage ?? options.selectMessage
      : matched
        ? null
        : hasSelection ? options.notFoundMessage : options.selectMessage;
    root.replaceChildren(matched ?? renderEmptyMessage(message ?? ''));
  };

  root.addEventListener('dashboard-route-change', (event) => {
    if (!(event instanceof CustomEvent) || event.detail?.parameter !== options.routeParameter) return;
    render(event.detail.value);
  });
  render('');
  return root;
}
