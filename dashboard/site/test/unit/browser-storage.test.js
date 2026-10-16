import { describe, expect, it } from 'vitest';
import { inspectBrowserStorage } from '../../src/browser-storage.js';

describe('browser storage guarantees', () => {
  it('reports persistence without inferring private mode from quota', async () => {
    const storage = /** @type {StorageManager} */ ({
      persisted: async () => true,
      estimate: async () => ({ quota: 1000, usage: 200 })
    });
    expect(await inspectBrowserStorage(storage)).toEqual({ persisted: true, quota: 1000, usage: 200 });
  });

  it('reports best-effort storage in private or regular sessions', async () => {
    const storage = /** @type {StorageManager} */ ({ persisted: async () => false });
    expect(await inspectBrowserStorage(storage)).toEqual({ persisted: false, quota: null, usage: null });
  });

  it('requests persistence before warning about a normal first visit', async () => {
    const storage = /** @type {StorageManager} */ ({
      persisted: async () => false,
      persist: async () => true
    });
    expect(await inspectBrowserStorage(storage)).toEqual({ persisted: true, quota: null, usage: null });
  });

  it('handles missing storage APIs on iOS', async () => {
    expect(await inspectBrowserStorage(undefined)).toEqual({ persisted: null, quota: null, usage: null });
  });

  it('preserves persistence when quota inspection fails and excludes error messages', async () => {
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      persisted: async () => true,
      persist: async () => true,
      estimate: async () => { throw new Error('sensitive context'); }
    }));
    expect(await inspectBrowserStorage(storage)).toEqual({
      persisted: true, quota: null, usage: null, errorName: 'Error'
    });
  });
});
