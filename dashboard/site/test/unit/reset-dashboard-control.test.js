// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboardAppCaches, renderResetDashboardControl, resetLocalDashboardData } from '../../src/components/reset-dashboard-control.js';
import { DATABASE_NAME, openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

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

/** @param {string} name */
function openBlockingDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  localStorage.clear();
  await Promise.all([
    deleteDatabase(DATABASE_NAME),
    deleteDatabase(NON_APP_DATABASE_NAME)
  ]);
});

describe('dashboard local-data reset', () => {
  it('clears only owned app caches', async () => {
    /** @type {string[]} */
    const removed = [];
    const cacheStorage = {
      keys: async () => ['central-agentic-ops-dashboard-app-v1', 'central-agentic-ops-dashboard-data-v1',
        'central-agentic-ops-dashboard-config', 'unrelated-cache'],
      delete: async (/** @type {string} */ key) => { removed.push(key); return true; }
    };
    await clearDashboardAppCaches(/** @type {CacheStorage} */ (/** @type {unknown} */ (cacheStorage)));
    expect(removed).toEqual([
      'central-agentic-ops-dashboard-app-v1',
      'central-agentic-ops-dashboard-data-v1',
      'central-agentic-ops-dashboard-config'
    ]);
  });

  it('clears the cached website from Settings after confirmation', async () => {
    const reload = vi.fn();
    const cacheStorage = { keys: vi.fn().mockResolvedValue(['central-agentic-ops-dashboard-app-v1']), delete: vi.fn().mockResolvedValue(true) };
    const control = renderResetDashboardControl({
      storage: localStorage, indexedDB,
      cacheStorage: /** @type {CacheStorage} */ (/** @type {unknown} */ (cacheStorage)),
      reload, clearApp: true
    });
    document.body.append(control);
    expect(control.textContent).toContain('Clear app');
    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-trigger')).click();
    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-confirm')).click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(cacheStorage.delete).toHaveBeenCalledWith('central-agentic-ops-dashboard-app-v1');
  });
  it('deletes the scoped database and clears only dashboard localStorage entries', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    database.close();
    await openDatabase(NON_APP_DATABASE_NAME);
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    localStorage.setItem('unrelated-dashboard-setting', 'value');

    await resetLocalDashboardData(localStorage, indexedDB);

    expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBeNull();
    expect(localStorage.getItem('unrelated-dashboard-setting')).toBe('value');
    const databases = await indexedDB.databases();
    expect(databases.some(({ name }) => name === DATABASE_NAME)).toBe(false);
    expect(databases.some(({ name }) => name === NON_APP_DATABASE_NAME)).toBe(true);
  });

  it('requires confirmation before resetting and reloads after success', async () => {
    const reload = vi.fn();
    const control = renderResetDashboardControl({ storage: localStorage, indexedDB, reload });
    document.body.append(control);
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');

    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-trigger')).click();
    const dialog = /** @type {HTMLDialogElement} */ (control.querySelector('dialog'));
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('cannot be undone');
    expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('dark');

    /** @type {HTMLButtonElement} */ (dialog.querySelector('.reset-dashboard-confirm')).click();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBeNull();
  });

  it('shows blocking-tab feedback and a friendly message when reset stays blocked', async () => {
    const reload = vi.fn();
    const database = /** @type {IDBDatabase} */ (await openBlockingDatabase(DATABASE_NAME));
    const control = renderResetDashboardControl({ storage: localStorage, indexedDB, reload });
    document.body.append(control);

    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-trigger')).click();
    const dialog = /** @type {HTMLDialogElement} */ (control.querySelector('dialog'));
    /** @type {HTMLButtonElement} */ (dialog.querySelector('.reset-dashboard-confirm')).click();

    await vi.waitFor(() => expect(dialog.textContent).toContain('other open dashboard tabs'));
    await vi.waitFor(() => expect(dialog.textContent).toContain('another open dashboard tab is still using local data'), {
      timeout: 5000
    });
    expect(reload).not.toHaveBeenCalled();
    database.close();
  });

  it('stops reacting to status changes once the control detaches from the document', async () => {
    const reload = vi.fn();
    const database = /** @type {IDBDatabase} */ (await openBlockingDatabase(DATABASE_NAME));
    const control = renderResetDashboardControl({ storage: localStorage, indexedDB, reload });
    document.body.append(control);

    /** @type {HTMLButtonElement} */ (control.querySelector('.reset-dashboard-trigger')).click();
    const dialog = /** @type {HTMLDialogElement} */ (control.querySelector('dialog'));
    /** @type {HTMLButtonElement} */ (dialog.querySelector('.reset-dashboard-confirm')).click();

    await vi.waitFor(() => expect(dialog.textContent).toContain('other open dashboard tabs'));

    control.remove();
    // Let the MutationObserver microtask backing createFactoryScope run.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    const statusBeforeUnblock = dialog.querySelector('output')?.textContent;
    database.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The effect stopped when the control detached, so the confirmation
    // moving from blocked to reset can no longer update the detached output,
    // even though the underlying reset itself still completes.
    expect(dialog.querySelector('output')?.textContent).toBe(statusBeforeUnblock);
  });

  it('clears localStorage even when app database deletion fails', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    const deletionError = new Error('deletion failed');
    const failingIndexedDB = {
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
