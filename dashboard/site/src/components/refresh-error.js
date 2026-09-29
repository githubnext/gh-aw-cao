import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderCloseButton } from './ui-primitives.js';
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
 * @param {'refreshing'|'current'|'stale'} state
 */
export function renderDashboardSnapshotStatus(snapshot, state) {
  const timestamp = Date.parse(snapshot.createdAt);
  const date = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : 'an unknown time';
  const message = state === 'refreshing'
    ? `Refreshing dashboard data. Showing the last complete snapshot from ${date}.`
    : state === 'stale'
      ? `Dashboard refresh failed. Showing the last complete snapshot from ${date}.`
      : `Dashboard data is current as of ${date}.`;
  return h('p', {
    className: 'dashboard-snapshot-status',
    role: 'status',
    'aria-live': 'polite'
  }, message);
}
