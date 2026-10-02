import { h } from '../dom.js';
import { resolveTitleLink } from './link-content.js';
import { renderRouteDetailView } from './route-detail-view.js';
import { rowsFor } from './source-rows.js';
import { text } from './count-formatters.js';
import { createDebug } from '../debug.js';

const debugEntityRoute = createDebug('entity-route-config');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderEntityRoute(context) {
  const rows = context.sourceNames.flatMap((sourceName) => rowsFor(context.sources, sourceName));
  const identifierField = text(context.titleLink?.['identifier-field']);
  if (!identifierField) {
    // A missing identifier field makes every match below compare against
    // `row[undefined]`, so the route silently never resolves an entity.
    debugEntityRoute({ event: 'identifier-field-missing', pageId: context.pageId });
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
      debugEntityRoute({ event: 'allocated', pageId: context.pageId, hasTitleLink: titleLink !== null });
      return {
        title: routeValue.trim(),
        titleLink
      };
    },
    renderContent: (_entity, routeValue) => h('p', { className: 'sr-only' }, `Insights for ${routeValue.trim()}`)
  });
}
