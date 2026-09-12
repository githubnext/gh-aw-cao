import { h } from '../dom.js';
import { deleteCanonicalDatabase } from '../data/storage/indexeddb.js';
import { octicon } from '../octicons.js';
import { createModalDialog, renderCloseButton } from './ui-primitives.js';

const APP_INDEXEDDB_PREFIX = 'gh-aw-cao-';

/**
 * Delete dashboard IndexedDB databases for this app. Always deletes the canonical
 * database, and additionally deletes discovered `gh-aw-cao-` prefixed databases
 * when `indexedDB.databases()` is available.
 *
 * @param {IDBFactory} indexedDB
 */
async function deleteAppDatabases(indexedDB) {
  await deleteCanonicalDatabase(indexedDB);
  if (typeof indexedDB.databases !== 'function') return;
  const databases = await indexedDB.databases();
  const databaseNames = databases.flatMap((database) => {
    const name = database?.name;
    return typeof name === 'string' && name.startsWith(APP_INDEXEDDB_PREFIX) ? [name] : [];
  });
  await Promise.all(
    databaseNames.map((name) => new Promise((resolve, reject) => {
        let settled = false;
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          reject(request.error);
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          reject(new Error(`Database deletion was blocked: ${name}`));
        };
      }))
  );
}

/**
 * @param {Storage} storage
 * @param {IDBFactory} indexedDB
 */
export async function resetLocalDashboardData(storage, indexedDB) {
  try {
    await deleteAppDatabases(indexedDB);
  } finally {
    storage.clear();
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
        await resetLocalDashboardData(storage, indexedDB);
        reload();
      } catch {
        status.textContent = 'Could not reset local dashboard data.';
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
