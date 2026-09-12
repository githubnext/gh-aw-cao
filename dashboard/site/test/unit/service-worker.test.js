import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('service-worker.js'), 'utf8');

function serviceWorkerHarness() {
  /** @type {Record<string, (event: any) => void>} */
  const listeners = {};
  /** @type {Map<string, Response>} */
  const entries = new Map();
  const cache = {
    /** @param {string | Request} key @param {Response} response */
    put: async (key, response) => entries.set(String(key), response.clone()),
    /** @param {string | Request} key */
    match: async (key) => entries.get(String(key))?.clone(),
    /** @param {string | Request} key */
    delete: async (key) => entries.delete(String(key))
  };
  const fetch = vi.fn(async () => new Response('updated data'));
  const deleteCache = vi.fn(async () => {
    entries.clear();
    return true;
  });
  const worker = {
    location: {
      href: 'https://example.test/dashboard/service-worker.js',
      origin: 'https://example.test'
    },
    registration: { scope: 'https://example.test/dashboard/' },
    navigator: {
      connection: { type: 'wifi', saveData: false }
    },
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    /** @param {string} type @param {(event: any) => void} listener */
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    }
  };
  vm.runInNewContext(source, {
    self: worker,
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: deleteCache,
      match: cache.match
    },
    fetch,
    URL,
    Response,
    AbortSignal,
    Set,
    Error,
    Promise,
    JSON
  });
  return {
    listeners,
    worker,
    fetch,
    entries,
    deleteCache
  };
}

/** @param {(event: any) => void} listener @param {Record<string, unknown>} event */
async function dispatchExtendedEvent(listener, event) {
  /** @type {Promise<unknown> | undefined} */
  let task;
  listener({ ...event, waitUntil: (/** @type {Promise<unknown>} */ value) => { task = value; } });
  await task;
}

describe('dashboard service worker', () => {
  it('downloads configured dashboard data during periodic background sync with no page open', async () => {
    const { listeners, worker, fetch } = serviceWorkerHarness();
    const configured = vi.fn();
    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CONFIGURE_BACKGROUND_DATA',
        urls: [
          'https://example.test/dashboard/gh-aw-logs.jsonl',
          'https://example.test/dashboard/inventory-sources.json'
        ]
      },
      ports: [{ postMessage: configured }]
    });
    expect(configured).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BACKGROUND_DATA_CONFIGURED'
    }));

    await dispatchExtendedEvent(listeners.periodicsync, {
      tag: 'central-agentic-ops-dashboard-data'
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    await dispatchExtendedEvent(listeners.periodicsync, {
      tag: 'central-agentic-ops-dashboard-data'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    worker.navigator.connection.type = 'cellular';
    await dispatchExtendedEvent(listeners.periodicsync, {
      tag: 'central-agentic-ops-dashboard-data'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('serves cached dashboard assets and data while offline', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    const request = new Request('https://example.test/dashboard/src/main.js');
    fetch.mockResolvedValueOnce(new Response('online'));
    /** @type {Promise<Response> | undefined} */
    let response;
    listeners.fetch({
      request,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; }
    });
    await expect(response).resolves.toHaveProperty('status', 200);
    expect(entries.size).toBe(1);

    fetch.mockRejectedValueOnce(new TypeError('offline'));
    listeners.fetch({
      request,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; }
    });
    await expect((await response)?.text()).resolves.toBe('online');
  });

  it('clears persisted scheduling before worker unregistration', async () => {
    const { listeners, entries } = serviceWorkerHarness();
    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CONFIGURE_BACKGROUND_DATA',
        urls: ['https://example.test/dashboard/gh-aw-logs.jsonl']
      },
      ports: [{ postMessage: vi.fn() }]
    });
    expect(entries.size).toBeGreaterThan(0);
    const cleared = vi.fn();

    await dispatchExtendedEvent(listeners.message, {
      data: { type: 'CLEAR_BACKGROUND_DATA' },
      ports: [{ postMessage: cleared }]
    });

    expect(cleared).toHaveBeenCalledWith(expect.objectContaining({ type: 'BACKGROUND_DATA_CLEARED' }));
  });

});
