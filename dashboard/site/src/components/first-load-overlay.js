import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { derived, effect, onCleanup, render, state } from '../reactive.js';
import { browserFirstLoad } from '../browser-first-load.js';
import { createModalDialog, renderCloseButton } from './ui-primitives.js';
import { restoreDashboardTheme } from './theme-settings.js';
import { createFirstLoadMessagePicker, FIRST_LOAD_MESSAGE_INTERVAL_MS } from './first-load-messages.js';

/**
 * Browser-local import presentation cannot be expressed as a canonical data query.
 * @param {{ document: Document, signal: AbortSignal, retry: () => void }} options
 */
export function mountFirstLoadOverlay({ document, signal, retry }) {
  const { dialog, open, close } = createModalDialog({
    className: 'first-load-overlay',
    ariaLabel: 'Preparing your dashboard'
  });
  const dismiss = () => browserFirstLoad.set((current) => ({ ...current, dismissed: true }));
  const dismissButton = h('button', {
    type: 'button',
    className: 'first-load-browse',
    onClick: dismiss
  }, 'Explore while data loads');
  const retryButton = h('button', {
    type: 'button',
    className: 'first-load-browse',
    onClick: retry
  }, 'Retry import');
  const title = h('h2');
  const message = h('p', { className: 'first-load-message', 'aria-live': 'off' });
  const nextMessage = createFirstLoadMessagePicker();
  const currentMessage = state(nextMessage());
  const rotating = derived(() => {
    const current = browserFirstLoad.get();
    return current.status === 'loading' && !current.dismissed;
  }, { signal });
  const status = h('p', { className: 'first-load-status', role: 'status' });
  const progress = h('div', { className: 'first-load-progress' });
  const dismissControl = renderCloseButton({
    className: 'first-load-close',
    label: 'Dismiss import screen',
    onClick: dismiss
  });
  dialog.append(h('section', { className: 'first-load-card' },
    dismissControl,
    h('div', { className: 'first-load-symbol', 'aria-hidden': 'true' }, octicon('download')),
    h('p', { className: 'first-load-eyebrow' }, 'A fresh start'),
    title,
    h('p', { className: 'first-load-description' },
      'This browser does not have a dashboard snapshot yet. We are downloading the published activity data and building a local database so you can explore your campaigns.'),
    progress,
    message,
    status,
    h('ol', { className: 'first-load-steps' },
      h('li', null, h('strong', null, 'Download'), h('span', null, 'Collect the latest published snapshot')),
      h('li', null, h('strong', null, 'Prepare'), h('span', null, 'Process and cache data in this browser')),
      h('li', null, h('strong', null, 'Explore'), h('span', null, 'Views update as evidence becomes available'))
    ),
    h('p', { className: 'first-load-note' }, 'The first import can take several minutes. Future visits reuse cached data.'),
    dismissButton,
    retryButton,
    h('p', { className: 'first-load-note' }, 'Dismissing this screen does not cancel the import.')
  ));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  }, { signal });
  document.body.append(dialog);
  render(title, () => browserFirstLoad.get().status === 'failed'
    ? 'The first import could not finish.'
    : 'Making room for your campaigns.', { signal });
  render(message, () => currentMessage.get(), { signal });
  effect(() => {
    message.hidden = !rotating.get();
    if (!rotating.get()) return;
    const timer = setInterval(() => currentMessage.set(nextMessage()), FIRST_LOAD_MESSAGE_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  }, { signal });
  render(status, () => {
    const current = browserFirstLoad.get();
    if (current.status === 'failed') return 'Campaign status is not available yet. Retry the import to finish preparing your dashboard.';
    return current.total
      ? `${current.completed ?? 0} of ${current.total} activity files processed. Final preparation follows.`
      : 'Preparing the latest activity snapshot...';
  }, { signal });
  render(progress, () => {
    const current = browserFirstLoad.get();
    if (current.status === 'failed') return [];
    return h('progress', {
      'aria-label': 'Activity files processed',
      ...(current.total ? { max: current.total, value: current.completed ?? 0 } : {})
    });
  }, { signal });
  effect(() => {
    const current = browserFirstLoad.get();
    const visible = current.status !== 'inactive' && !current.dismissed;
    dismissButton.hidden = current.status === 'failed';
    retryButton.hidden = current.status !== 'failed';
    if (visible && !dialog.open) {
      restoreDashboardTheme(dialog);
      open();
    }
    else if (!visible && dialog.open) close();
  }, { signal });
  signal.addEventListener('abort', () => {
    close();
    dialog.remove();
  }, { once: true });
}
