import { cancelDataProcessing } from './data-processor.js';
import { publishNotification } from './notification-service.js';
import { createDebug } from './debug.js';

/** Milliseconds of uninterrupted work before the cancel command is offered. */
const REVEAL_DELAY = 5000;

/** Milliseconds between elapsed-time updates once the command is offered. */
const ELAPSED_TICK = 1000;

const MESSAGE = 'Preparing dashboard data is taking longer than expected.';
const DETAILS_SUBTITLE = 'Why this can happen';
const EXPLANATION_DETAILS = [
  'Large datasets, GitHub API rate limits, or a slow network connection can extend preparation time.',
  'Cancelling stops the current computation so you can retry once the underlying issue clears.'
];

const debugCancelCommand = createDebug('cancel-command');

/** @param {number} elapsedMs */
function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Offers a dashboard command that cancels a runaway data computation.
 *
 * The command stays hidden while work completes promptly and is revealed only
 * once the computation has run for longer than a user would expect, so the
 * cancellation affordance appears exactly when it is useful. Cancelling asks
 * the data worker to stop; a worker that cannot stop cooperatively because it
 * is blocked in a runaway computation is terminated.
 *
 * @param {Document} document
 * @param {{ delay?: number, cancel?: () => number, now?: () => number }} [options]
 * @returns {{ complete: () => void, cancel: () => void }}
 */
export function offerCancelCommand(document, options = {}) {
  const cancel = options.cancel ?? cancelDataProcessing;
  const delay = Number.isFinite(options.delay) ? Number(options.delay) : REVEAL_DELAY;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let finished = false;
  let offeredAt = 0;
  /** @type {ReturnType<typeof publishNotification> | undefined} */
  let notification;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let elapsedTimer;

  const refreshElapsed = () => {
    if (finished || !notification) return;
    notification.update({
      message: MESSAGE,
      duration: 0,
      action: { label: 'Cancel computation', run: requestCancel },
      detailsSubtitle: DETAILS_SUBTITLE,
      details: [`Elapsed time: ${formatElapsed(now() - offeredAt)}`, ...EXPLANATION_DETAILS]
    });
  };

  const timer = setTimeout(() => {
    if (finished) return;
    offeredAt = now();
    notification = publishNotification({
      message: MESSAGE,
      duration: 0,
      action: { label: 'Cancel computation', run: requestCancel },
      detailsSubtitle: DETAILS_SUBTITLE,
      details: [`Elapsed time: ${formatElapsed(0)}`, ...EXPLANATION_DETAILS]
    }, document);
    elapsedTimer = setInterval(refreshElapsed, ELAPSED_TICK);
    debugCancelCommand({ event: 'offered', delayMs: delay });
  }, delay);

  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearInterval(elapsedTimer);
    document.removeEventListener('keydown', onKeydown);
    notification?.dismiss();
    debugCancelCommand({ event: 'completed', offered: Boolean(notification) });
  };

  const requestCancel = () => {
    if (finished || !notification) return;
    clearInterval(elapsedTimer);
    notification.update({ message: 'Cancelling…', duration: 0 });
    const workerId = cancel();
    debugCancelCommand({ event: 'cancel-requested', workerId });
  };

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape' || !notification) return;
    requestCancel();
  }

  document.addEventListener('keydown', onKeydown);

  return { complete, cancel: requestCancel };
}

/**
 * Reports whether an error came from a user-requested data-processing cancel.
 * @param {unknown} error
 */
export function isDataProcessingCancellation(error) {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error && current.name === 'DataProcessingCancelledError') return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Keeps the dashboard usable after the user cancels startup data preparation.
 * Offers a reload, and a local data reset for a browser whose disposable
 * canonical database no longer opens or answers queries.
 *
 * @param {Document} document
 * @param {{ reload: () => void, reset: () => Promise<void> }} options
 */
export function offerStartupRecovery(document, options) {
  debugCancelCommand({ event: 'startup-recovery-offered' });
  /** @type {ReturnType<typeof publishNotification>} */
  const notification = publishNotification({
    message: 'Dashboard data loading was cancelled.',
    tone: 'warning',
    duration: 0,
    detailsSubtitle: 'Recovery options',
    details: [
      'Reload to retry loading dashboard data.',
      'If loading keeps stalling, reset local data. This deletes the dashboard data cached in this browser and reloads it from the published source.'
    ],
    actions: [
      { label: 'Reload', run: () => options.reload() },
      {
        label: 'Reset local data',
        run: () => {
          notification.update({ message: 'Resetting local dashboard data…', tone: 'warning', duration: 0 });
          debugCancelCommand({ event: 'startup-reset-requested' });
          options.reset().then(
            () => options.reload(),
            (error) => {
              debugCancelCommand({
                event: 'startup-reset-failed',
                errorName: error instanceof Error ? error.name : 'Unknown'
              });
              notification.update({
                message: error instanceof Error && error.name === 'IndexedDBDeleteBlockedError'
                  ? 'Reset is waiting for other open dashboard tabs. Close them and reload.'
                  : 'Could not reset local dashboard data.',
                tone: 'error',
                duration: 0,
                actions: [{ label: 'Reload', run: () => options.reload() }]
              });
            }
          );
        }
      }
    ]
  }, document);
  return notification;
}
