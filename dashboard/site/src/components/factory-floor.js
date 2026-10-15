import { renderFactoryElement } from './factory-elements.js';
import { renderStationGrid } from './station-grid.js';
import { createDebug } from '../debug.js';

const debugFactoryFloor = createDebug('factory-floor');

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} FactoryFloorScope */
/** @typedef {'campaigns'|'repositories'} FactoryStationId */

/** Built-in presets selectable by canonical string in `config.stations`. */
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
 * @typedef {{ id: string, source: string, icon: string, label: string, href?: string, 'unavailable-detail'?: string, 'unavailable-description'?: string }} StationEntry
 */

/**
 * Resolves one `config.stations` entry. A canonical string selects a built-in
 * preset bound through `roleNames`; a mapping declares the station fully.
 * @param {unknown} entry
 * @param {Record<string, string>} roleNames
 * @returns {{ definition: import('./station-grid.js').StationDefinition, sourceName: string } | undefined}
 */
function resolveStation(entry, roleNames) {
  if (typeof entry === 'string') {
    if (!Object.hasOwn(STATION_DEFINITIONS, entry)) return undefined;
    return {
      definition: { id: entry, ...STATION_DEFINITIONS[/** @type {FactoryStationId} */ (entry)] },
      sourceName: roleNames[entry]
    };
  }
  if (!entry || typeof entry !== 'object') return undefined;
  const station = /** @type {Record<string, unknown>} */ (entry);
  if (![station.id, station.source, station.icon, station.label].every((value) => typeof value === 'string' && value)) return undefined;
  return {
    definition: {
      id: /** @type {string} */ (station.id),
      icon: /** @type {string} */ (station.icon),
      label: /** @type {string} */ (station.label),
      href: typeof station.href === 'string' ? station.href : undefined,
      unavailableDetail: typeof station['unavailable-detail'] === 'string' ? station['unavailable-detail'] : '',
      unavailableDescription: typeof station['unavailable-description'] === 'string'
        ? station['unavailable-description']
        : `${station.label} unavailable`
    },
    sourceName: /** @type {string} */ (station.source)
  };
}

/**
 * @param {SourceBindings} sources
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 * @param {Record<string, string>} roleNames
 * @param {Array<FactoryStationId | StationEntry>} selectedStations
 */
export function renderFactoryFloor(sources, animateNumbers, scope, roleNames, selectedStations) {
  const bindings = selectedStations.flatMap((entry) => {
    const resolved = resolveStation(entry, roleNames);
    return resolved ? [{ definition: resolved.definition, source: sources[resolved.sourceName] }] : [];
  });
  debugFactoryFloor({ event: 'composed', stationCount: bindings.length, animate: animateNumbers });
  return renderStationGrid(bindings, {
    animate: animateNumbers,
    signal: scope.signal,
    className: 'factory-floor',
    compactClassName: 'factory-floor-compact',
    activeClassName: 'factory-floor-active',
    listClassName: 'factory-stations'
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
  const configuredStations = Array.isArray(context.elementConfig?.stations) ? context.elementConfig.stations : null;
  /** @type {unknown[]} */
  const entries = configuredStations ?? ['campaigns', 'repositories'];
  const selectedStations = /** @type {Array<FactoryStationId | StationEntry>} */ (entries.filter((entry) => resolveStation(entry, FLOOR_DEFAULT_SOURCES) !== undefined));
  if (configuredStations && selectedStations.length !== configuredStations.length) {
    debugFactoryFloor({
      event: 'station-config-filtered',
      pageId: context.pageId,
      viewId: context.viewId,
      configuredCount: configuredStations.length,
      selectedCount: selectedStations.length
    });
  }
  debugFactoryFloor({
    event: 'element-selected',
    pageId: context.pageId,
    viewId: context.viewId,
    stations: selectedStations.map((entry) => typeof entry === 'string' ? entry : entry.id).join(',')
  });
  return renderFactoryElement(
    context,
    FLOOR_DEFAULT_SOURCES,
    (roleNames) => selectedStations.flatMap((entry) => {
      const resolved = resolveStation(entry, roleNames);
      return resolved ? [resolved.sourceName] : [];
    }),
    (sources, scope, roleNames) => renderFactoryFloor(
      sources,
      context.elementConfig?.animate === 'number',
      scope,
      roleNames,
      selectedStations
    )
  );
}
