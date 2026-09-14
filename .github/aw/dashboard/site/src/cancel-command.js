import { cancelDataProcessing } from './data-processor.js';
import { publishNotification } from './notification-service.js';

/** Milliseconds of uninterrupted work before the cancel command is offered. */
const REVEAL_DELAY = 5000;

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
 * @param {{ delay?: number, cancel?: () => number }} [options]
 * @returns {{ complete: () => void, cancel: () => void }}
 */
export function offerCancelCommand(document, options = {}) {
  const cancel = options.cancel ?? cancelDataProcessing;
  const delay = Number.isFinite(options.delay) ? Number(options.delay) : REVEAL_DELAY;

  let finished = false;
  /** @type {ReturnType<typeof publishNotification> | undefined} */
  let notification;
  const timer = setTimeout(() => {
    if (finished) return;
    notification = publishNotification({
      message: 'Preparing dashboard data is taking longer than expected.',
      duration: 0,
      action: { label: 'Cancel computation', run: requestCancel }
    }, document);
  }, delay);

  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKeydown);
    notification?.dismiss();
  };

  const requestCancel = () => {
    if (finished || !notification) return;
    notification.update({ message: 'Cancelling…', duration: 0 });
    cancel();
  };

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape' || !notification) return;
    requestCancel();
  }

  document.addEventListener('keydown', onKeydown);

  return { complete, cancel: requestCancel };
}
