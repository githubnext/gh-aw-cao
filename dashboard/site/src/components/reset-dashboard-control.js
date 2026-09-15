import { h } from '../dom.js';
import { deleteCanonicalDatabase } from '../data/storage/indexeddb.js';
import { octicon } from '../octicons.js';
import { clearScopedStorage } from '../storage-scope.js';
import { createDebug } from '../debug.js';
import { createModalDialog, renderCloseButton } from './ui-primitives.js';

const debug = createDebug('data:reset');

/**
 * @param {IDBFactory} indexedDB
 * @param {{ onBlocked?: () => void }} [options]
 */
async function deleteAppDatabases(indexedDB, options = {}) {
  await deleteCanonicalDatabase(indexedDB, options);
}

/**
 * @param {Storage} storage
 * @param {IDBFactory} indexedDB
 * @param {{ onBlocked?: () => void }} [options]
 */
export async function resetLocalDashboardData(storage, indexedDB, options = {}) {
  debug('resetting local dashboard data');
  try {
    await deleteAppDatabases(indexedDB, options);
    debug('reset local dashboard data succeeded');
  } catch (error) {
    debug('reset local dashboard data failed', error);
    throw error;
  } finally {
    clearScopedStorage(storage);
  }
}

function browserStorage() {
  try {
    return globalThis.window?.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * @param {{ storage?: Storage, indexedDB?: IDBFactory, reload?: () => void }} [options]
 * @returns {HTMLElement}
 */
export function renderResetDashboardControl(options = {}) {
  const storage = options.storage ?? browserStorage();
  const indexedDB = options.indexedDB ?? globalThis.window?.indexedDB;
  const reload = options.reload ?? (() => globalThis.window?.location.reload());
  /** @type {HTMLButtonElement} */
  let trigger;
  const { dialog, open, close } = createModalDialog({
    className: 'reset-dashboard-dialog',
    ariaLabel: 'Reset dashboard confirmation',
    onFallbackClose: () => trigger.focus()
  });
  const status = /** @type {HTMLOutputElement} */ (h('output', {
    className: 'reset-dashboard-status',
    'aria-live': 'polite'
  }));
  const cancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'reset-dashboard-cancel',
    onClick: close
  }, 'Cancel'));
  const confirm = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'reset-dashboard-confirm',
    onClick: async () => {
      if (!storage || !indexedDB) {
        status.textContent = 'Local browser storage is unavailable.';
        return;
      }
      confirm.disabled = true;
      cancel.disabled = true;
      status.textContent = 'Resetting…';
      try {
        await resetLocalDashboardData(storage, indexedDB, {
          onBlocked: () => {
            status.textContent = 'Waiting for other open dashboard tabs to close…';
          }
        });
        reload();
      } catch (error) {
        status.textContent = error instanceof Error && error.name === 'IndexedDBDeleteBlockedError'
          ? 'Reset timed out because another open dashboard tab is still using local data. Close other tabs and try again.'
          : 'Could not reset local dashboard data.';
        confirm.disabled = false;
        cancel.disabled = false;
      }
    }
  }, 'Reset'));
  trigger = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'reset-dashboard-trigger',
    onClick: open
  }, octicon('trash'), h('span', null, 'Reset local data')));
  dialog.append(
    h('header', { className: 'reset-dashboard-dialog-header' },
      h('h2', null, 'Reset local data?'),
      renderCloseButton({
        className: 'reset-dashboard-dialog-close',
        label: 'Close reset confirmation',
        onClick: close
      })
    ),
    h('div', { className: 'reset-dashboard-dialog-body' },
      h('p', null, 'This permanently deletes the indexed dashboard data and all local settings stored in this browser.'),
      h('strong', null, 'This action cannot be undone.')
    ),
    h('footer', { className: 'reset-dashboard-dialog-footer' }, status, cancel, confirm)
  );
  dialog.addEventListener('close', () => trigger.focus());
  return h('div', { className: 'reset-dashboard-control' }, trigger, dialog);
}
