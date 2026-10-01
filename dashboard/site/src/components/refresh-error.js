import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatMediumUtcDateTime, renderCloseButton, renderTooltip } from './ui-primitives.js';
import { createDebug } from '../debug.js';
import { effect } from '../reactive.js';
import { isDashboardRateLimited } from '../rate-limit-notification.js';
import { createFactoryScope } from './factory-elements.js';

const debugRefreshError = createDebug('refresh-error');

/**
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
export function renderRefreshError(retry, { hasCachedSnapshot = true } = {}) {
  const element = h(
    'section',
    { className: 'source-refresh-error', role: 'alert' },
    h(
      'div',
      { className: 'source-refresh-error-message' },
      h('strong', null, 'Dashboard data could not be refreshed.'),
      h('p', null, hasCachedSnapshot
        ? 'Some views may be unavailable. You are seeing the most recent cached data.'
        : 'A complete dashboard snapshot is not available yet.')
    ),
    h(
      'div',
      { className: 'source-refresh-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'refresh-button source-refresh-retry',
          onclick: () => {
            debugRefreshError({ event: 'retry-requested' });
            retry();
          }
        },
        octicon('sync'),
        h('span', null, 'Retry')
      ),
      renderCloseButton({
        className: 'source-refresh-dismiss',
        label: 'Dismiss partial data warning',
        onClick: () => {
          debugRefreshError({ event: 'dismissed' });
          element.remove();
        }
      })
    )
  );
  debugRefreshError({ event: 'shown' });
  return element;
}

/**
 * @param {{ createdAt: string }} snapshot
 */
export function renderDashboardSnapshotStatus(snapshot) {
  const date = formatSnapshotDate(snapshot);
  return h('p', {
    className: 'dashboard-snapshot-status',
    role: 'status',
    'aria-live': 'polite'
  }, `Dashboard refresh failed. Showing the last complete snapshot from ${date}.`);
}

/**
 * @param {{ createdAt: string } | null} snapshot
 * @param {{ refreshing?: boolean }} [options]
 */
export function renderDashboardCurrentStatus(snapshot, { refreshing = false } = {}) {
  const scope = createFactoryScope();
  const normalIcon = snapshot ? (refreshing ? 'sync' : 'check-circle-fill') : 'sync';
  const trigger = h('button', { type: 'button', className: 'tooltip-trigger' }, octicon(normalIcon));
  const description = h('span', { className: 'tooltip-description' });
  const status = renderTooltip({
    id: 'dashboard-current-status-tooltip',
    label: 'Dashboard data status',
    trigger,
    content: description,
    className: 'dashboard-current-status'
  });
  let currentIcon = normalIcon;
  effect(() => {
    const limited = isDashboardRateLimited();
    const icon = limited ? 'alert' : normalIcon;
    if (icon !== currentIcon) {
      trigger.replaceChildren(octicon(icon));
      currentIcon = icon;
    }
    const label = limited ? 'Dashboard is rate limited' : refreshing ? 'Refreshing dashboard data' : 'Dashboard data is current';
    trigger.setAttribute('aria-label', label);
    description.textContent = limited
      ? 'Dashboard requests are rate limited. Please try again shortly.'
      : snapshot
        ? refreshing
          ? `Showing the last complete snapshot from ${formatSnapshotDate(snapshot)} while dashboard data refreshes.`
          : `Dashboard data is current as of ${formatSnapshotDate(snapshot)}.`
        : '';
    status.classList.toggle('dashboard-current-status-limited', limited);
    status.classList.toggle('dashboard-current-status-refreshing', !limited && refreshing);
    status.hidden = !snapshot && !limited;
  }, { signal: scope.signal });
  scope.bind(status);
  return status;
}

/**
 * @param {{ createdAt: string }} snapshot
 */
function formatSnapshotDate(snapshot) {
  const timestamp = Date.parse(snapshot.createdAt);
  return Number.isFinite(timestamp)
    ? formatMediumUtcDateTime(timestamp)
    : 'an unknown time';
}
