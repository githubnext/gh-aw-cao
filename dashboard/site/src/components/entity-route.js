import { h } from '../dom.js';
import { createDebug } from '../debug.js';
import { resolveTitleLink } from './link-content.js';
import { renderRouteDetailView } from './route-detail-view.js';
import { rowsFor } from './source-rows.js';
import { text } from './count-formatters.js';

const debugEntityRouteConfig = createDebug('entity-route-config');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderEntityRoute(context) {
  const rows = context.sourceNames.flatMap((sourceName) => rowsFor(context.sources, sourceName));
  const identifierField = text(context.titleLink?.['identifier-field']);
  if (!identifierField) {
    debugEntityRouteConfig({ event: 'identifier-field-missing', pageId: context.pageId });
  }
  return renderRouteDetailView(context, {
    category: 'entity-route',
    rootClassName: 'entity-route',
    datasetKey: 'entity',
    selectMessage: 'Select an entity to view its insights.',
    notFoundMessage: 'Entity not found.',
    rows,
    match: (candidateRows, routeValue) => candidateRows.find((row) => String(row[identifierField]) === routeValue.trim()),
    allocation: (entity, routeValue) => {
      const titleLink = resolveTitleLink(entity, context.titleLink);
      debugEntityRouteConfig({ event: 'allocated', pageId: context.pageId, hasTitleLink: titleLink !== null });
      return {
        title: routeValue.trim(),
        titleLink
      };
    },
    renderContent: (_entity, routeValue) => h('p', { className: 'sr-only' }, `Insights for ${routeValue.trim()}`)
  });
}
