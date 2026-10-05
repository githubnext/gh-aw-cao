import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { derived, effect, onCleanup, render, state } from '../reactive.js';
import { browserFirstLoad } from '../browser-first-load.js';
import { createDebug } from '../debug.js';
import { createModalDialog } from './ui-primitives.js';
import { restoreDashboardTheme } from './theme-settings.js';
import { createFirstLoadMessagePicker, FIRST_LOAD_MESSAGE_INTERVAL_MS } from './first-load-messages.js';

const debugFirstLoadOverlay = createDebug('first-load-overlay');

/** @param {string} wide @param {string} compact */
function responsiveCopy(wide, compact) {
  return [
    h('span', { className: 'first-load-wide-copy' }, wide),
    h('span', { className: 'first-load-compact-copy' }, compact)
  ];
}

/**
 * Browser-local import presentation cannot be expressed as a canonical data query.
 * @param {{ document: Document, signal: AbortSignal, retry: () => void }} options
 */
export function mountFirstLoadOverlay({ document, signal: ownerSignal, retry }) {
  if (ownerSignal.aborted || browserFirstLoad.get().status === 'inactive') return;
  debugFirstLoadOverlay({ event: 'mounted', status: browserFirstLoad.get().status });
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  ownerSignal.addEventListener('abort', () => lifetime.abort(), { once: true, signal });
  const { dialog, open, close } = createModalDialog({
    className: 'first-load-overlay',
    ariaLabel: 'Preparing your dashboard'
  });
  signal.addEventListener('abort', () => {
    close();
    dialog.remove();
  }, { once: true });
  const dismiss = () => {
    debugFirstLoadOverlay({ event: 'dismissed' });
    browserFirstLoad.set((current) => ({ ...current, dismissed: true }));
  };
  const dismissButton = h('button', {
    type: 'button',
    className: 'first-load-browse',
    onClick: dismiss
  }, 'Explore data');
  const retryButton = h('button', {
    type: 'button',
    className: 'first-load-browse',
    onClick: () => {
      debugFirstLoadOverlay({ event: 'retry-requested' });
      retry();
    }
  }, 'Retry import');
  const title = h('h2');
  const eyebrow = h('p', { className: 'first-load-eyebrow' });
  const description = h('p', { className: 'first-load-description' });
  const durationNote = h('p', { className: 'first-load-note first-load-wide-copy' });
  const message = h('p', { className: 'first-load-message', 'aria-live': 'off' });
  const nextMessage = createFirstLoadMessagePicker();
  const currentMessage = state(nextMessage());
  const rotating = derived(() => {
    const current = browserFirstLoad.get();
    return current.status === 'loading' && !current.dismissed;
  }, { signal });
  const status = h('p', { className: 'first-load-status', role: 'status' });
  const progress = h('div', { className: 'first-load-progress' });
  const continuationNote = h('p', { className: 'first-load-note' }, responsiveCopy(
    'Dismissing this screen does not cancel the import.',
    'Dismiss anytime. The import will continue.'
  ));
  dialog.append(
    h('div', { className: 'first-load-background', 'aria-hidden': 'true' }),
    h('section', { className: 'first-load-card' },
    h('div', { className: 'first-load-symbol', 'aria-hidden': 'true' }, octicon('download')),
    eyebrow,
    title,
    description,
    progress,
    message,
    status,
    h('ol', { className: 'first-load-steps' },
      h('li', null, h('strong', null, 'Download'), h('span', null, 'Collect the latest published snapshot')),
      h('li', null, h('strong', null, 'Prepare'), h('span', null, 'Process and cache data in this browser')),
      h('li', null, h('strong', null, 'Explore'), h('span', null, 'Views update as evidence becomes available'))
    ),
    durationNote,
    h('p', { className: 'first-load-note first-load-server-option' },
      'For larger datasets, deploy a CAO backend server to run queries server-side and avoid this browser import. See ',
      h('a', { href: 'https://githubnext.github.io/gh-aw-cao/deployment/', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'deployment options (opens in a new tab)' }, 'deployment options'),
      '.'
    ),
    dismissButton,
    retryButton,
    continuationNote
  ));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  }, { signal });
  document.body.append(dialog);
  render(eyebrow, () => browserFirstLoad.get().reason === 'upgrade' ? 'Dashboard update' : 'A fresh start', { signal });
  render(description, () => browserFirstLoad.get().reason === 'upgrade'
    ? responsiveCopy(
      'This version needs to rebuild the local database from published activity data. Updating your browser copy can take several minutes.',
      'Updating the local database for this version can take a few minutes.'
    )
    : responsiveCopy(
      'This browser does not have a dashboard snapshot yet. We are downloading the published activity data and building a local database so you can explore your campaigns.',
      'Preparing a local copy of activity data. First visits can take a few minutes.'
    ), { signal });
  render(durationNote, () => browserFirstLoad.get().reason === 'upgrade'
    ? 'This update can take several minutes. Future visits reuse cached data.'
    : 'The first import can take several minutes. Future visits reuse cached data.', { signal });
  render(title, () => {
    const current = browserFirstLoad.get();
    if (current.status === 'failed') return responsiveCopy(
      current.reason === 'upgrade' ? 'The dashboard update could not finish.' : 'The first import could not finish.',
      'Import incomplete.'
    );
    return responsiveCopy(
      current.reason === 'upgrade' ? 'Updating your dashboard.' : 'Making room for your campaigns.',
      'Preparing your dashboard.'
    );
  }, { signal });
  render(message, () => currentMessage.get(), { signal });
  effect(() => {
    message.hidden = !rotating.get();
    if (!rotating.get()) return;
    const timer = setInterval(() => currentMessage.set(nextMessage()), FIRST_LOAD_MESSAGE_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  }, { signal });
  render(status, () => {
    const current = browserFirstLoad.get();
    if (current.status === 'failed') return responsiveCopy(
      'Campaign status is not available yet. Retry the import to finish preparing your dashboard.',
      'Try again to finish preparing your dashboard.'
    );
    if (current.stage === 'maintenance') return 'Applying retention limits to the local database...';
    if (current.stage === 'inventory') return 'Preparing inventory and dashboard metadata...';
    if (current.stage === 'queries') return 'Refreshing dashboard queries...';
    if (current.reason === 'upgrade' && !current.stage) return 'Updating the local database for this version...';
    return current.total
      ? 'Importing activity files and preparing the local database...'
      : 'Preparing the latest activity snapshot...';
  }, { signal });
  render(progress, () => {
    const current = browserFirstLoad.get();
    if (current.status === 'failed') return [];
    return h('progress', {
      'aria-label': 'Dashboard import progress',
      ...(current.total ? { max: current.total, value: current.completed ?? 0 } : {})
    });
  }, { signal });
  effect(() => {
    const current = browserFirstLoad.get();
    if (current.status === 'inactive') {
      lifetime.abort();
      return;
    }
    const visible = !current.dismissed;
    dismissButton.hidden = current.status === 'failed';
    retryButton.hidden = current.status !== 'failed';
    continuationNote.hidden = current.status === 'failed';
    if (visible && !dialog.open) {
      restoreDashboardTheme(dialog);
      open();
    }
    else if (!visible && dialog.open) close();
  }, { signal });
}
