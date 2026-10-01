import { h } from '../dom.js';
import { render } from '../reactive.js';
import { createAnimatedNumber } from './animated-number.js';
import { formatCount } from './count-formatters.js';
import { formatPercent } from '../view-formatters.js';
import { renderIconSpan } from './ui-primitives.js';
import { createDebug } from '../debug.js';

const debugFactoryStation = createDebug('factory-station');

/** @typedef {{ text: string, href?: string }} StationDetail */

/**
 * @param {string} icon
 * @param {{ animate?: boolean, final?: boolean, format?: 'count'|'percent', href?: string, signal: AbortSignal }} options
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, unavailable?: boolean, label: string, value: number, displayValue?: string, detail?: StationDetail }) => void }}
 */
export function renderFactoryStation(icon, options) {
  const element = h('li', { className: 'factory-station' });
  const value = createAnimatedNumber({ animate: options.animate, signal: options.signal });
  debugFactoryStation({ event: 'bound', format: options.format ?? 'count', hasHref: Boolean(options.href) });
  /** @type {boolean | undefined} */
  let wasUnavailable;
  /** @type {boolean | undefined} */
  let wasPending;
  return {
    element,
    bind(read) {
      render(element, () => {
        const station = read();
        if (station.unavailable !== wasUnavailable) {
          wasUnavailable = station.unavailable;
          debugFactoryStation({ event: 'unavailable-changed', unavailable: station.unavailable === true });
        }
        if (station.pending !== wasPending) {
          wasPending = station.pending;
          debugFactoryStation({ event: 'pending-changed', pending: station.pending });
        }
        element.className = `factory-station${options.final ? ' factory-station-final' : ''}`
          + `${station.pending ? ' factory-station-pending' : ''}`
          + `${!station.pending && !station.unavailable && station.value === 0 ? ' factory-station-empty' : ''}`;
        if (station.pending) element.setAttribute('aria-busy', 'true');
        else element.removeAttribute('aria-busy');
        const count = station.pending ? '' : station.unavailable
          ? 'Unavailable'
          : station.displayValue ?? (options.format === 'percent' ? formatPercent(station.value) : formatCount(station.value));
        value.set({
          text: count,
          target: !station.pending && !station.unavailable ? station.value : undefined,
          href: options.href && !station.pending && !station.unavailable ? options.href : undefined
        });
        const detail = station.pending || !station.detail
          ? ''
          : station.detail.href
            ? h('a', { href: station.detail.href }, station.detail.text)
            : station.detail.text;
        return [
          renderIconSpan('factory-station-icon', icon, { ariaHidden: true }),
          h('span', {}, station.label),
          value.element,
          h('small', {}, detail)
        ];
      }, { signal: options.signal });
    }
  };
}