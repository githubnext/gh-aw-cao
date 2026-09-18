// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('reports a subscription error instead of hanging when the dashboard context is invalid', async () => {
  /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
  const listeners = new Map();
  /** @type {Record<string, unknown>[]} */
  const posted = [];
  globalThis.self = /** @type {typeof globalThis.self} */ (/** @type {unknown} */ ({
    addEventListener: (/** @type {string} */ type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => {
      listeners.set(type, listener);
    },
    postMessage: (/** @type {Record<string, unknown>} */ message) => {
      posted.push(structuredClone(message));
    }
  }));
  await import('../../src/data-worker.js');

  // A context missing the required "pages" array is invalid and previously
  // caused the worker to throw synchronously without ever replying, leaving
  // the caller's promise (and its loading UI) waiting forever.
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'broken-view',
      sourceNames: ['runs'],
      context: { queries: [] }
    }
  });

  const errorMessage = posted.find(({ subscriptionId }) => subscriptionId === 'broken-view');
  expect(errorMessage).toBeDefined();
  expect(typeof errorMessage?.error).toBe('string');
});
