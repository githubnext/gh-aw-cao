import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { octicon } from '../octicons.js';
import { renderLabeledSpan, renderTooltip } from './ui-primitives.js';

/**
 * @typedef {{
 *   available: boolean,
 *   evaluatedAt: string,
 *   duration: string,
 *   start: string,
 *   end: string
 * }} HorizonViewModel
 */

/**
 * @param {{
 *   dashboard: import('../presenter.js').PresentableDashboard,
 *   initialValue: HorizonViewModel,
 *   formatDate: (value: string) => string
 * }} options
 * @returns {{
 *   element: HTMLElement,
 *   update: (next: HorizonViewModel) => void,
 *   dispose: () => void
 * }}
 */
export function renderDashboardHorizon(options) {
  const lifetime = new AbortController();
  const value = state(options.initialValue);
  const horizon = options.dashboard.horizon;
  const label = horizon?.label || 'Horizon';
  const skeleton = h('span', { 'aria-hidden': 'true' });
  const durationLabel = h('strong');
  const accessibleLabel = h('span', { className: 'sr-only action-label' });
  const toggle = h(
    'button',
    {
      type: 'button',
      className: 'horizon-toggle',
      'aria-expanded': 'false',
      'aria-describedby': 'dashboard-horizon-tooltip'
    },
    octicon('clock'),
    accessibleLabel
  );
  const startTime = /** @type {HTMLTimeElement} */ (h('time'));
  const endTime = /** @type {HTMLTimeElement} */ (h('time'));
  const durationValue = h('span');
  const content = renderTooltip({
    id: 'dashboard-horizon-tooltip',
    label: 'Horizon unavailable',
    trigger: toggle,
    content: [durationLabel, h('span', null, label)],
    className: 'horizon-summary',
    contentClassName: 'horizon-tooltip'
  });
  const details = h(
    'div',
    { className: 'horizon-details', role: 'group', 'aria-label': 'Horizon details' },
    h(
      'span',
      { className: 'horizon-details-description' },
      horizon?.tooltip.description ?? 'Evidence coverage and data quality for this dashboard.'
    ),
    h(
      'span',
      { className: 'horizon-details-values' },
      renderLabeledSpan('Start', startTime),
      renderLabeledSpan('End', endTime),
      renderLabeledSpan('Duration', durationValue)
    )
  );
  const root = h('div', { className: 'dashboard-horizon' }, skeleton);

  effect(() => {
    const current = value.get();
    root.classList.toggle('dashboard-horizon-skeleton', !current.available);
    if (!current.available) {
      root.setAttribute('aria-label', 'Horizon unavailable');
      root.removeAttribute('data-dashboard-evaluated-at');
      if (root.firstElementChild !== skeleton) root.replaceChildren(skeleton);
      return;
    }

    root.removeAttribute('aria-label');
    root.dataset.dashboardEvaluatedAt = current.evaluatedAt;
    if (root.firstElementChild !== content) root.replaceChildren(content, details);
    const fullLabel = `${label} ${current.duration}`;
    toggle.setAttribute('aria-label', `${fullLabel}. Show time and mode filters`);
    accessibleLabel.textContent = fullLabel;
    durationLabel.textContent = current.duration;
    durationValue.textContent = current.duration;
    startTime.dateTime = current.start;
    startTime.textContent = `${options.formatDate(current.start)} UTC`;
    endTime.dateTime = current.end;
    endTime.textContent = `${options.formatDate(current.end)} UTC`;
  }, { signal: lifetime.signal });

  return {
    element: root,
    /**
     * Updates the bound horizon. Once resolved, an empty refresh retains the
     * global horizon instead of flashing the loading skeleton.
     * @param {HorizonViewModel} next
     */
    update(next) {
      value.set((current) => {
        if (current.available && !next.available) return current;
        return current.available === next.available
          && current.evaluatedAt === next.evaluatedAt
          && current.duration === next.duration
          && current.start === next.start
          && current.end === next.end
          ? current
          : next;
      });
    },
    dispose() {
      lifetime.abort();
    }
  };
}
