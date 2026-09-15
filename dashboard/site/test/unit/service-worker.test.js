import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('service-worker.js'), 'utf8');

/** @param {string[]} [cacheKeys] */
function serviceWorkerHarness(cacheKeys = []) {
  /** @type {Record<string, (event: any) => void>} */
  const listeners = {};
  /** @type {Map<string, Response>} */
  const entries = new Map();
  const cache = {
    /** @param {string | Request} key @param {Response} response */
    put: async (key, response) => { entries.set(String(key), response.clone()); },
    /** @param {string | Request} key */
    match: async (key) => entries.get(String(key))?.clone(),
    /** @param {string | Request} key */
    delete: async (key) => entries.delete(String(key)),
    keys: async () => [...entries.keys()].map((url) => new Request(url))
  };
  const fetch = vi.fn(async (
    /** @type {string | URL | Request} */ _url,
    /** @type {RequestInit | undefined} */ _init
  ) => new Response('updated data'));
  const deleteCache = vi.fn(async (key) => {
    cacheKeys = cacheKeys.filter((candidate) => candidate !== key);
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
      keys: async () => cacheKeys,
      delete: deleteCache,
      match: cache.match
    },
    fetch,
    URL,
    Response,
    AbortSignal,
    Request,
    Set,
    Error,
    Promise,
    JSON
  });
  return {
    listeners,
    worker,
    fetch,
    cache,
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
    const { listeners, worker, fetch, entries } = serviceWorkerHarness();
    const payloadHashes = JSON.stringify({
      'gh-aw-logs.sqlite': 'b'.repeat(64),
      'gh-aw-logs-shards/logs-1.jsonl': 'c'.repeat(64)
    });
    fetch.mockImplementation(async (url) => new Response(
      String(url).endsWith('/payload-hashes.json') ? payloadHashes : 'updated data'
    ));
    const configured = vi.fn();
    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CONFIGURE_BACKGROUND_DATA',
        urls: [
          'https://example.test/dashboard/payload-hashes.json',
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

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(entries.has('https://example.test/dashboard/gh-aw-logs-shards/logs-1.jsonl')).toBe(true);
    expect(entries.has('https://example.test/dashboard/payload-hashes.json')).toBe(true);
    entries.set(
      'https://example.test/dashboard/.dashboard-data-update-config',
      new Response(JSON.stringify({
        urls: [
          'https://example.test/dashboard/payload-hashes.json',
          'https://example.test/dashboard/inventory-sources.json'
        ],
        lastSuccess: 0
      }))
    );
    await dispatchExtendedEvent(listeners.periodicsync, {
      tag: 'central-agentic-ops-dashboard-data'
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/logs-1.jsonl'))).toHaveLength(1);
    worker.navigator.connection.type = 'cellular';
    await dispatchExtendedEvent(listeners.periodicsync, {
      tag: 'central-agentic-ops-dashboard-data'
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not publish a new payload hash when the matching JSONL download fails', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    const payloadHashes = JSON.stringify({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) });
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/payload-hashes.json')) return new Response(payloadHashes);
      throw new TypeError('network failure');
    });
    const completed = vi.fn();

    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'DOWNLOAD_DATA',
        urls: [
          'https://example.test/dashboard/payload-hashes.json'
        ]
      },
      ports: [{ postMessage: completed }]
    });

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ type: 'DOWNLOAD_FAILED' }));
    expect(entries.has('https://example.test/dashboard/payload-hashes.json')).toBe(false);
  });

  it('removes an obsolete hash when background downloads fall back to ETags', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    const hashesUrl = 'https://example.test/dashboard/payload-hashes.json';
    entries.set(hashesUrl, Response.json({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) }));
    fetch.mockImplementation(async (url) => (
      String(url).endsWith('/payload-hashes.json')
        ? new Response(null, { status: 404 })
        : new Response('updated data', { headers: { etag: '"updated"' } })
    ));

    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'DOWNLOAD_DATA',
        urls: [
          hashesUrl
        ]
      },
      ports: [{ postMessage: vi.fn() }]
    });

    expect(entries.has(hashesUrl)).toBe(false);
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

    const dataRequest = new Request('https://example.test/dashboard/gh-aw-logs-shards/logs-1.jsonl');
    entries.set(String(dataRequest), new Response('cached data'));
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    listeners.fetch({
      request: dataRequest,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; },
      waitUntil: () => {}
    });
    await expect((await response)?.text()).resolves.toBe('cached data');
  });

  it('streams foreground dashboard data before its cache write completes', async () => {
    const { listeners, fetch, cache, entries } = serviceWorkerHarness();
    let finishCacheWrite = () => {};
    const cacheWriteBlocked = new Promise((resolve) => { finishCacheWrite = () => resolve(undefined); });
    vi.spyOn(cache, 'put').mockImplementation(async (key, response) => {
      await cacheWriteBlocked;
      entries.set(String(key), response.clone());
    });
    fetch.mockResolvedValueOnce(new Response('streamed data'));
    const request = new Request('https://example.test/dashboard/gh-aw-logs-shards/logs-1.jsonl');
    /** @type {Promise<Response> | undefined} */
    let response;
    /** @type {Promise<unknown> | undefined} */
    let cacheWrite;

    listeners.fetch({
      request,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; },
      waitUntil: (/** @type {Promise<unknown>} */ value) => { cacheWrite = value; }
    });

    await expect((await response)?.text()).resolves.toBe('streamed data');
    expect(entries.has(String(request))).toBe(false);
    finishCacheWrite();
    await cacheWrite;
    expect(entries.has(String(request))).toBe(true);
  });

  it('falls back to the cached application shell for offline navigation', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    entries.set('https://example.test/dashboard/', new Response('cached shell'));
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    /** @type {Promise<Response> | undefined} */
    let response;

    listeners.fetch({
      request: {
        method: 'GET',
        url: 'https://example.test/dashboard/repositories',
        cache: 'default',
        mode: 'navigate'
      },
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; }
    });

    await expect((await response)?.text()).resolves.toBe('cached shell');
  });

  it('caches application assets independently of background data updates', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();

    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CACHE_APP_ASSETS',
        urls: [
          'https://example.test/dashboard/',
          'https://example.test/dashboard/src/main.js',
          'https://outside.example/main.js'
        ]
      }
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(entries.has('https://example.test/dashboard/')).toBe(true);
    expect(entries.has('https://example.test/dashboard/src/main.js')).toBe(true);
  });

  it('keeps successful assets when the connection drops part way through caching', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/src/main.js')) throw new TypeError('connection lost');
      return new Response(`cached ${url}`);
    });

    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CACHE_APP_ASSETS',
        urls: [
          'https://example.test/dashboard/',
          'https://example.test/dashboard/src/main.js',
          'https://example.test/dashboard/manifest.webmanifest'
        ]
      }
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(entries.has('https://example.test/dashboard/')).toBe(true);
    expect(entries.has('https://example.test/dashboard/src/main.js')).toBe(false);
    expect(entries.has('https://example.test/dashboard/manifest.webmanifest')).toBe(true);
  });

  it('preserves a cached asset when its network refresh is interrupted', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    const request = new Request('https://example.test/dashboard/src/main.js');
    entries.set(String(request), new Response('previous version'));
    fetch.mockRejectedValueOnce(new TypeError('connection lost'));
    /** @type {Promise<Response> | undefined} */
    let response;

    listeners.fetch({
      request,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; }
    });

    await expect((await response)?.text()).resolves.toBe('previous version');
    await expect(entries.get(String(request))?.text()).resolves.toBe('previous version');
  });

  it('removes obsolete versioned caches after activation', async () => {
    const { listeners, worker, deleteCache } = serviceWorkerHarness([
      'central-agentic-ops-dashboard-data-development',
      'central-agentic-ops-dashboard-data-old',
      'central-agentic-ops-dashboard-app-development',
      'central-agentic-ops-dashboard-app-old',
      'central-agentic-ops-dashboard-config',
      'unrelated-cache'
    ]);

    await dispatchExtendedEvent(listeners.activate, {});

    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith('central-agentic-ops-dashboard-data-old');
    expect(deleteCache).toHaveBeenCalledWith('central-agentic-ops-dashboard-app-old');
    expect(worker.clients.claim).toHaveBeenCalledOnce();
  });

  it('does not use stale cached data for hash-identified foreground downloads', async () => {
    const { listeners, fetch, entries } = serviceWorkerHarness();
    const request = new Request('https://example.test/dashboard/gh-aw-logs-shards/logs-1.jsonl', {
      cache: 'no-store'
    });
    entries.set(String(request), new Response('stale data'));
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    /** @type {Promise<Response> | undefined} */
    let response;

    listeners.fetch({
      request,
      respondWith: (/** @type {Promise<Response>} */ value) => { response = value; }
    });

    await expect(response).rejects.toThrow('offline');
  });

  it('clears persisted scheduling before worker unregistration', async () => {
    const { listeners, entries } = serviceWorkerHarness();
    await dispatchExtendedEvent(listeners.message, {
      data: {
        type: 'CONFIGURE_BACKGROUND_DATA',
        urls: ['https://example.test/dashboard/payload-hashes.json']
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
