import { h } from '../dom.js';
import { resolveTitleLink } from './link-content.js';
import { createRouteView } from './route-empty-state.js';
import { rowsFor } from './source-rows.js';
import { text } from './count-formatters.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderEntityRoute(context) {
  const rows = context.sourceNames.flatMap((sourceName) => rowsFor(context.sources, sourceName));
  const identifierField = text(context.titleLink?.['identifier-field']);
  const root = createRouteView({
    rootClassName: 'entity-route',
    routeParameter: context.routeParameter,
    datasetKey: 'entity',
    selectMessage: 'Select an entity to view its insights.',
    notFoundMessage: 'Entity not found.',
    renderMatched: (routeValue) => {
      const identifier = routeValue.trim();
      const entity = rows.find((row) => String(row[identifierField]) === identifier);
      if (!entity) return null;
      root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
        bubbles: true,
        detail: {
          title: identifier,
          titleLink: resolveTitleLink(entity, context.titleLink)
        }
      }));
      return h('p', { className: 'sr-only' }, `Insights for ${identifier}`);
    }
  });
  return root;
}
