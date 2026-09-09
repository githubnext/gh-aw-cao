import { cancelDataProcessing } from './data-processor.js';

/** Milliseconds of uninterrupted work before the cancel command is offered. */
const REVEAL_DELAY = 5000;

/**
 * @param {Document} document
 */
function installStyles(document) {
  if (document.querySelector('style[data-cancel-command-styles]')) return;

  const style = document.createElement('style');
  style.dataset.cancelCommandStyles = '';
  style.textContent = `
.cancel-command {
  position: fixed;
  z-index: 1001;
  right: 16px;
  bottom: 60px;
  max-width: calc(100vw - 32px);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--attention);
  border-radius: 6px;
  background: var(--attention-muted);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  color: var(--fg);
  font-size: 13px;
}
.cancel-command-button {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--canvas-subtle);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.cancel-command-button:hover {
  background: var(--neutral-muted);
}
@media (max-width: 480px) {
  .cancel-command {
    left: 16px;
    grid-template-columns: 1fr;
  }
  .cancel-command-button {
    justify-self: end;
  }
}`;
  document.head.append(style);
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
 * @param {{ delay?: number, cancel?: () => number }} [options]
 * @returns {{ complete: () => void, cancel: () => void }}
 */
export function offerCancelCommand(document, options = {}) {
  const cancel = options.cancel ?? cancelDataProcessing;
  const delay = Number.isFinite(options.delay) ? Number(options.delay) : REVEAL_DELAY;
  installStyles(document);

  const panel = document.createElement('div');
  panel.className = 'cancel-command';
  panel.setAttribute('role', 'status');
  panel.hidden = true;

  const message = document.createElement('span');
  message.textContent = 'Preparing dashboard data is taking longer than expected.';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cancel-command-button';
  button.textContent = 'Cancel computation';

  panel.append(message, button);

  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) panel.hidden = false;
  }, delay);

  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKeydown);
    panel.remove();
  };

  const requestCancel = () => {
    if (finished || panel.hidden) return;
    button.disabled = true;
    message.textContent = 'Cancelling…';
    cancel();
  };

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape' || panel.hidden) return;
    requestCancel();
  }

  button.addEventListener('click', requestCancel);
  document.addEventListener('keydown', onKeydown);
  document.body.append(panel);

  return { complete, cancel: requestCancel };
}
