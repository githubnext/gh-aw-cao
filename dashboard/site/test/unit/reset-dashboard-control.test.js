// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderResetDashboardControl, resetLocalDashboardData } from '../../src/components/reset-dashboard-control.js';
import { DATABASE_NAME, openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

const APP_AUX_DATABASE_NAME = 'gh-aw-cao-dashboard-data-aux';
const NON_APP_DATABASE_NAME = 'third-party-dashboard-data';

/** @param {string} name */
function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
}

/** @param {string} name */
function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const database = request.result;
      database.close();
      resolve(undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  localStorage.clear();
  await Promise.all([
    deleteDatabase(DATABASE_NAME),
    deleteDatabase(APP_AUX_DATABASE_NAME),
    deleteDatabase(NON_APP_DATABASE_NAME)
  ]);
});

describe('dashboard local-data reset', () => {
  it('deletes app indexedDB databases and clears all localStorage entries', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    database.close();
    await openDatabase(APP_AUX_DATABASE_NAME);
    await openDatabase(NON_APP_DATABASE_NAME);
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    localStorage.setItem('unrelated-dashboard-setting', 'value');

    await resetLocalDashboardData(localStorage, indexedDB);

    expect(localStorage.length).toBe(0);
    const databases = await indexedDB.databases();
    expect(databases.some(({ name }) => name === DATABASE_NAME)).toBe(false);
    expect(databases.some(({ name }) => name === APP_AUX_DATABASE_NAME)).toBe(false);
    expect(databases.some(({ name }) => name === NON_APP_DATABASE_NAME)).toBe(true);
  });

  it('requires confirmation before resetting and reloads after success', async () => {
    const reload = vi.fn();
    const control = renderResetDashboardControl({ storage: localStorage, indexedDB, reload });
    document.body.append(control);
    localStorage.setItem('setting', 'value');

    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-trigger')).click();
    const dialog = /** @type {HTMLDialogElement} */ (control.querySelector('dialog'));
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('cannot be undone');
    expect(localStorage.getItem('setting')).toBe('value');

    /** @type {HTMLButtonElement} */ (dialog.querySelector('.reset-dashboard-confirm')).click();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(localStorage.length).toBe(0);
  });

  it('clears localStorage even when app database deletion fails', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    const deletionError = new Error('deletion failed');
    const failingIndexedDB = {
      databases: async () => [{ name: APP_AUX_DATABASE_NAME }],
      deleteDatabase: () => {
        const request = /** @type {{ error: Error, onerror?: () => void }} */ ({ error: deletionError });
        queueMicrotask(() => request.onerror?.());
        return request;
      }
    };

    await expect(resetLocalDashboardData(
      localStorage,
      /** @type {IDBFactory} */ (/** @type {unknown} */ (failingIndexedDB))
    )).rejects.toThrow('deletion failed');
    expect(localStorage.length).toBe(0);
  });

  it('still resets localStorage when indexedDB.databases is unavailable', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    const deletedNames = /** @type {string[]} */ ([]);
    const legacyIndexedDB = {
      /** @param {string} name */
      deleteDatabase: (name) => {
        deletedNames.push(name);
        const request = /** @type {{ onsuccess?: () => void }} */ ({});
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }
    };

    await expect(resetLocalDashboardData(
      localStorage,
      /** @type {IDBFactory} */ (/** @type {unknown} */ (legacyIndexedDB))
    )).resolves.toBeUndefined();
    expect(deletedNames).toEqual([DATABASE_NAME]);
    expect(localStorage.length).toBe(0);
  });
});
