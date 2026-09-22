import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { render } from '../reactive.js';
import { createAnimatedNumber } from './animated-number.js';
import { formatCount } from './count-formatters.js';

/**
 * @param {string} icon
 * @param {{ animate?: boolean, final?: boolean, href?: string, signal: AbortSignal }} options
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, unavailable?: boolean, label: string, value: number, detail?: string }) => void }}
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
        const count = station.pending ? '' : station.unavailable ? 'Unavailable' : formatCount(station.value);
        value.set({
          text: count,
          target: !station.pending && !station.unavailable ? station.value : undefined
        });
        const content = [
          h('span', { className: 'factory-station-icon', 'aria-hidden': 'true' }, octicon(icon)),
          h('span', {}, station.label),
          value.element
        ];
        const primary = options.href && !station.pending && !station.unavailable
          ? h('a', { className: 'factory-station-link', href: options.href }, content)
          : content;
        const detail = station.pending ? '' : station.detail;
        return [
          primary,
          h('small', {}, detail)
        ];
      }, { signal: options.signal });
    }
  };
}