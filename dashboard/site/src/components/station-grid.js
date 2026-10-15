import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';
import { createDebug } from '../debug.js';

const debugStationGrid = createDebug('station-grid');

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/**
 * @typedef {{
 *   id: string,
 *   icon: string,
 *   label: string,
 *   href?: string,
 *   unavailableDetail: string,
 *   unavailableDescription: string
 * }} StationDefinition
 */

/**
 * Renders a keyed grid of metric stations. Each station is described by a
 * declarative definition and bound to one presentation-ready source whose
 * first row supplies `value`, `display-value`, `detail`, `description`, and
 * `active`.
 * @param {Array<{ definition: StationDefinition, source: SourceBinding }>} bindings
 * @param {{ animate: boolean, signal: AbortSignal, className?: string, compactClassName?: string, activeClassName?: string, listClassName?: string }} options
 */
export function renderStationGrid(bindings, options) {
  const stations = bindings.map(({ definition, source }) => {
    const station = renderFactoryStation(definition.icon, {
      animate: options.animate,
      format: 'percent',
      href: definition.href,
      signal: options.signal
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
    return { id: definition.id, definition, source, element: station.element };
  });
  debugStationGrid({ event: 'composed', stationCount: stations.length, animate: options.animate });

  return renderReactiveGrid({
    className: [options.className, stations.length <= 2 ? options.compactClassName : ''].filter(Boolean).join(' '),
    activeClassName: options.activeClassName,
    listClassName: options.listClassName,
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
    signal: options.signal
  });
}
