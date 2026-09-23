import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} FactoryFloorScope */
/** @typedef {'campaigns'|'repositories'} FactoryStationId */

const STATION_DEFINITIONS = {
  campaigns: {
    source: 'overview-campaign-station',
    icon: 'organization',
    label: 'Campaign health',
    href: '#page-campaigns',
    unavailableDetail: '0/0 healthy campaigns',
    unavailableDescription: 'Campaign health unavailable'
  },
  repositories: {
    source: 'overview-repository-station',
    icon: 'repo',
    label: 'Repository coverage',
    href: '#page-repositories',
    unavailableDetail: '0/0 repositories reached',
    unavailableDescription: 'Repository coverage unavailable'
  }
};

/**
 * Renders presentation-ready station query payloads without deriving source
 * relationships or business metrics on the main thread.
 * @param {SourceBindings} sources
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 * @param {FactoryStationId[]} selectedStations
 */
export function renderFactoryFloor(sources, animateNumbers, scope, selectedStations) {
  const stations = selectedStations.map((id) => {
    const definition = STATION_DEFINITIONS[id];
    const source = sources[definition.source];
    const station = renderFactoryStation(definition.icon, {
      animate: animateNumbers,
      format: 'percent',
      href: definition.href,
      signal: scope.signal
    });
    station.bind(() => {
      const row = source.rows()[0] ?? {};
      const value = Number(row.value);
      return {
        pending: source.pending(),
        unavailable: source.unavailable(),
        label: definition.label,
        value: Number.isFinite(value) ? value : 0,
        displayValue: typeof row['display-value'] === 'string' ? row['display-value'] : undefined,
        detail: {
          text: typeof row.detail === 'string' ? row.detail : definition.unavailableDetail
        }
      };
    });
    return { id, definition, source, element: station.element };
  });

  return renderReactiveGrid({
    className: stations.length <= 2 ? 'factory-floor factory-floor-compact' : 'factory-floor',
    activeClassName: 'factory-floor-active',
    listClassName: 'factory-stations',
    items: () => stations,
    key: (station) => station.id,
    renderItem: (station) => station.element,
    active: () => stations.some(({ source }) => source.rows()[0]?.active === true),
    ariaLabel: () => `${stations.map(({ definition, source }) => {
      const row = source.rows()[0];
      return !source.pending() && !source.unavailable() && typeof row?.description === 'string'
        ? row.description
        : definition.unavailableDescription;
    }).join(', ')}.`,
    signal: scope.signal
  });
}

/**
 * Renders the JSON-selected factory floor from its declared presentation queries.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryFloorElement(context) {
  const selectedStations = Array.isArray(context.elementConfig?.stations)
    ? /** @type {FactoryStationId[]} */ (context.elementConfig.stations.filter((station) => station === 'campaigns' || station === 'repositories'))
    : /** @type {FactoryStationId[]} */ (['campaigns', 'repositories']);
  const sourceNames = selectedStations.map((station) => STATION_DEFINITIONS[station].source);
  const sources = bindFactorySources(context.sources, sourceNames, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const scope = createFactoryScope();
  const rendered = renderFactoryFloor(
    sources,
    context.elementConfig?.animate === 'number',
    scope,
    selectedStations
  );
  scope.bind(rendered);
  return rendered;
}
