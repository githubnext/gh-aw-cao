// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderResetDashboardControl, resetLocalDashboardData } from '../../src/components/reset-dashboard-control.js';
import { DATABASE_NAME, openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  localStorage.clear();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('dashboard local-data reset', () => {
  it('deletes the canonical database and clears all localStorage entries', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    database.close();
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    localStorage.setItem('unrelated-dashboard-setting', 'value');

    await resetLocalDashboardData(localStorage, indexedDB);

    expect(localStorage.length).toBe(0);
    const databases = await indexedDB.databases();
    expect(databases.some(({ name }) => name === DATABASE_NAME)).toBe(false);
  });

  it('requires confirmation before resetting and reloads after success', async () => {
    const reload = vi.fn();
    const control = renderResetDashboardControl({ storage: localStorage, indexedDB, reload });
    document.body.append(control);
    localStorage.setItem('setting', 'value');

    /** @type {HTMLButtonElement} */ (control.querySelector('.account-menu-reset')).click();
    const dialog = /** @type {HTMLDialogElement} */ (control.querySelector('dialog'));
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('cannot be undone');
    expect(localStorage.getItem('setting')).toBe('value');

    /** @type {HTMLButtonElement} */ (dialog.querySelector('.reset-dashboard-confirm')).click();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(localStorage.length).toBe(0);
  });
});
