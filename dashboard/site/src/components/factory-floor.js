import { bindFactorySources, createFactoryScope, resolveFactorySourceNames } from './factory-elements.js';
import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} FactoryFloorScope */
/** @typedef {'campaigns'|'repositories'} FactoryStationId */

const STATION_DEFINITIONS = {
  campaigns: {
    icon: 'organization',
    label: 'Campaign health',
    href: '#page-campaigns',
    unavailableDetail: '0/0 healthy campaigns',
    unavailableDescription: 'Campaign health unavailable'
  },
  repositories: {
    icon: 'repo',
    label: 'Repository coverage',
    href: '#page-repositories',
    unavailableDetail: '0/0 repositories reached',
    unavailableDescription: 'Repository coverage unavailable'
  }
};

/**
 * @param {SourceBindings} sources
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 * @param {Record<string, string>} roleNames
 * @param {FactoryStationId[]} selectedStations
 */
export function renderFactoryFloor(sources, animateNumbers, scope, roleNames, selectedStations) {
  const stations = selectedStations.map((id) => {
    const definition = STATION_DEFINITIONS[id];
    const source = sources[roleNames[id]];
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
 * Default role-to-source-name bindings for the overview page. A view may
 * override any entry through `config.sources` to bind the same element to
 * differently named sources.
 * @type {Record<string, string>}
 */
export const FLOOR_DEFAULT_SOURCES = {
  campaigns: 'overview-campaign-station',
  repositories: 'overview-repository-station'
};

/**
 * Renders the JSON-selected factory floor from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryFloorElement(context) {
  const roleNames = resolveFactorySourceNames(FLOOR_DEFAULT_SOURCES, context.elementConfig);
  const selectedStations = Array.isArray(context.elementConfig?.stations)
    ? /** @type {FactoryStationId[]} */ (context.elementConfig.stations.filter((station) => station === 'campaigns' || station === 'repositories'))
    : /** @type {FactoryStationId[]} */ (['campaigns', 'repositories']);
  const sources = bindFactorySources(context.sources, selectedStations.map((station) => roleNames[station]), {
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
    roleNames,
    selectedStations
  );
  scope.bind(rendered);
  return rendered;
}
