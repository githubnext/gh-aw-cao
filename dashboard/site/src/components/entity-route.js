import { h } from '../dom.js';
import { resolveTitleLink } from './link-content.js';
import { renderRouteDetailView } from './route-detail-view.js';
import { rowsFor } from './source-rows.js';
import { text } from './count-formatters.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderEntityRoute(context) {
  const rows = context.sourceNames.flatMap((sourceName) => rowsFor(context.sources, sourceName));
  const identifierField = text(context.titleLink?.['identifier-field']);
  return renderRouteDetailView(context, {
    category: 'entity-route',
    rootClassName: 'entity-route',
    datasetKey: 'entity',
    selectMessage: 'Select an entity to view its insights.',
    notFoundMessage: 'Entity not found.',
    rows,
    match: (candidateRows, routeValue) => candidateRows.find((row) => String(row[identifierField]) === routeValue.trim()),
    allocation: (entity, routeValue) => ({
      title: routeValue.trim(),
      titleLink: resolveTitleLink(entity, context.titleLink)
    }),
    renderContent: (_entity, routeValue) => h('p', { className: 'sr-only' }, `Insights for ${routeValue.trim()}`)
  });
}
