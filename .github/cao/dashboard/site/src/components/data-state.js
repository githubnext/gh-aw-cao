/**
 * GitHub Primer data-state metrics card grid component.
 */

import { h } from '../dom.js';
import { renderStatusBadge } from './badge.js';

/**
 * @typedef {import("../presenter.js").DataState} EffectiveDataState
 */

/**
 * Renders a single `metric-card` `<div>` with a labeled `<dt>`/`<dd>` pair
 * and a status badge, tagged with a `data-state-axis` attribute.
 * @param {string} label
 * @param {string} axis
 * @param {unknown} status
 * @returns {HTMLElement}
 */
function renderDataStateMetricCard(label, axis, status) {
  return h(
    'div',
    { className: 'metric-card' },
    h('dt', { className: 'metric-label' }, label),
    h(
      'dd',
      { className: 'metric-value', 'data-state-axis': axis },
      renderStatusBadge(status),
    ),
  );
}

/**
 * @param {EffectiveDataState | undefined} effectiveState
 * @returns {HTMLElement}
 */
export function renderDataStateMetrics(effectiveState) {
  const availability = effectiveState?.availability ?? 'available';

  return h(
    'dl',
    { className: 'data-state-summary metrics' },
    renderDataStateMetricCard('Availability', 'availability', availability)
  );
}
