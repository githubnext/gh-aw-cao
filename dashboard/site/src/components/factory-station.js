import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { render } from '../reactive.js';
import { createAnimatedNumber } from './animated-number.js';
import { formatCount } from './count-formatters.js';
import { formatPercent } from '../view-formatters.js';

/** @typedef {{ text: string, href?: string }} StationDetail */

/**
 * @param {string} icon
 * @param {{ animate?: boolean, final?: boolean, format?: 'count'|'percent', href?: string, signal: AbortSignal }} options
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, unavailable?: boolean, label: string, value: number, displayValue?: string, detail?: StationDetail }) => void }}
 */
export function renderFactoryStation(icon, options) {
  const element = h('li', { className: 'factory-station' });
  const value = createAnimatedNumber({ animate: options.animate, signal: options.signal });
  return {
    element,
    bind(read) {
      render(element, () => {
        const station = read();
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
          h('span', { className: 'factory-station-icon', 'aria-hidden': 'true' }, octicon(icon)),
          h('span', {}, station.label),
          value.element,
          h('small', {}, detail)
        ];
      }, { signal: options.signal });
    }
  };
}