import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryDirectories = /** @type {string[]} */ ([]);

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-sqlite-indexeddb-debug-'));
  temporaryDirectories.push(directory);
  return join(directory, 'dashboard.sqlite');
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
}

describe('sqlite-indexeddb debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { createSqliteIndexedDB } = await import('../../src/data/storage/sqlite-indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = createSqliteIndexedDB(filename);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('dashboard', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('runs', 'readwrite');
    await new Promise((resolve) => { transaction.oncomplete = resolve; });
    database.close();

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs database-opened and transaction-finished events under the predictable category when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=sqlite-indexeddb');
    const { createSqliteIndexedDB } = await import('../../src/data/storage/sqlite-indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = createSqliteIndexedDB(filename);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('dashboard', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:sqlite-indexeddb]',
      expect.objectContaining({ event: 'database-opened', oldVersion: 0, newVersion: 1, upgraded: true })
    );

    const transaction = database.transaction('runs', 'readwrite');
    await new Promise((resolve) => { transaction.oncomplete = resolve; });
    database.close();

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:sqlite-indexeddb]',
      expect.objectContaining({ event: 'transaction-finished', mode: 'readwrite', outcome: 'committed', storeCount: 1 })
    );
  });

  it('logs a rolled-back outcome when a transaction fails, without leaking record content', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=sqlite-indexeddb');
    const { createSqliteIndexedDB } = await import('../../src/data/storage/sqlite-indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = createSqliteIndexedDB(filename);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('dashboard', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const transaction = database.transaction('runs', 'readwrite');
    transaction.objectStore('runs').put({ id: 'secret-run-name', value: 1 });
    transaction.runRequest(() => { throw new Error('forced failure'); });
    await new Promise((resolve) => { transaction.onabort = resolve; });
    database.close();

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:sqlite-indexeddb]',
      expect.objectContaining({ event: 'transaction-finished', mode: 'readwrite', outcome: 'rolled-back' })
    );
    for (const call of debugFn.mock.calls) {
      const payload = JSON.stringify(call);
      expect(payload).not.toContain('secret-run-name');
    }
  });
});
