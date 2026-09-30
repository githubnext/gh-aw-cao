import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatMediumUtcDateTime, renderCloseButton, renderTooltip } from './ui-primitives.js';
import { createDebug } from '../debug.js';

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
 * @param {{ createdAt: string }} snapshot
 * @param {{ refreshing?: boolean }} [options]
 */
export function renderDashboardCurrentStatus(snapshot, { refreshing = false } = {}) {
  return renderTooltip({
    id: 'dashboard-current-status-tooltip',
    label: refreshing ? 'Refreshing dashboard data' : 'Dashboard data is current',
    description: refreshing
      ? `Showing the last complete snapshot from ${formatSnapshotDate(snapshot)} while dashboard data refreshes.`
      : `Dashboard data is current as of ${formatSnapshotDate(snapshot)}.`,
    icon: octicon(refreshing ? 'sync' : 'check-circle-fill'),
    className: refreshing ? 'dashboard-current-status dashboard-current-status-refreshing' : 'dashboard-current-status'
  });
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
