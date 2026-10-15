import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatMediumUtcDateTime, renderCloseButton, renderTooltip } from './ui-primitives.js';
import { createDebug } from '../debug.js';
import { effect, render } from '../reactive.js';
import { dashboardDataStatus } from '../dashboard-data-status.js';
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
  const phase = refreshing ? 'cached' : snapshot ? 'ready' : 'loading';
  const trigger = h('button', { type: 'button', className: 'tooltip-trigger' });
  const description = h('span', { className: 'tooltip-description' });
  const status = renderTooltip({
    id: 'dashboard-current-status-tooltip',
    label: 'Dashboard data status',
    trigger,
    content: description,
    className: 'dashboard-current-status'
  });
  let currentIcon = '';
  effect(() => {
    const limited = isDashboardRateLimited();
    const { icon, label, detail } = dataStatusPresentation(phase, snapshot, limited);
    if (icon !== currentIcon) {
      trigger.replaceChildren(octicon(icon));
      currentIcon = icon;
    }
    trigger.setAttribute('aria-label', label);
    description.textContent = detail;
    status.classList.toggle('dashboard-current-status-limited', limited);
    status.classList.toggle('dashboard-current-status-refreshing', !limited && refreshing);
    status.hidden = !snapshot && !limited;
  }, { signal: scope.signal });
  scope.bind(status);
  return status;
}

/** @param {AbortSignal} signal */
export function renderDashboardIngestionStatus(signal) {
  const element = h('div', {
    className: 'dashboard-ingestion-status',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true'
  });
  render(element, () => {
    const { phase, snapshot } = dashboardDataStatus.get();
    const status = dataStatusPresentation(phase, snapshot, isDashboardRateLimited());
    element.dataset.tone = status.tone;
    return [
      h('div', { className: 'dashboard-ingestion-status-heading' },
        octicon(status.icon), h('span', null, 'Data ingestion'), h('strong', null, status.value)),
      h('p', null, status.detail)
    ];
  }, { signal });
  return element;
}

/**
 * @param {ReturnType<typeof dashboardDataStatus.get>['phase']} phase
 * @param {{ createdAt: string } | null} snapshot
 * @param {boolean} limited
 */
function dataStatusPresentation(phase, snapshot, limited) {
  if (limited) return {
    icon: 'alert', tone: 'attention', value: 'Rate limited', label: 'Dashboard is rate limited',
    detail: 'Dashboard requests are rate limited. Please try again shortly.'
  };
  if (phase === 'stale') return {
    icon: 'alert', tone: 'danger', value: 'Refresh failed', label: 'Dashboard refresh failed',
    detail: snapshot
      ? `Showing the last complete snapshot from ${formatSnapshotDate(snapshot)}.`
      : 'A complete dashboard snapshot is not available yet.'
  };
  if (phase === 'ready') return {
    icon: 'check-circle-fill', tone: 'success', value: 'Current', label: 'Dashboard data is current',
    detail: snapshot
      ? `Dashboard data is current as of ${formatSnapshotDate(snapshot)}.`
      : 'Dashboard data loaded successfully.'
  };
  if (phase === 'cached') return {
    icon: 'sync', tone: 'muted', value: 'Refreshing', label: 'Refreshing dashboard data',
    detail: snapshot
      ? `Showing the last complete snapshot from ${formatSnapshotDate(snapshot)} while dashboard data refreshes.`
      : 'Refreshing dashboard data.'
  };
  return {
    icon: phase === 'loading' ? 'sync' : 'question', tone: 'muted',
    value: phase === 'loading' ? 'Importing' : 'Unknown', label: 'Dashboard data is not ready',
    detail: phase === 'loading'
      ? 'Waiting for dashboard data to finish loading.'
      : 'Dashboard refresh status is not available yet.'
  };
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
