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
