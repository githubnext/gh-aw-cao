const VERSION = 'development';
const DATA_CACHE = `central-agentic-ops-dashboard-data-${VERSION}`;
const APP_CACHE = `central-agentic-ops-dashboard-app-${VERSION}`;
const CONFIG_CACHE = 'central-agentic-ops-dashboard-config';
const CONFIG_URL = new URL('./.dashboard-data-update-config', self.registration.scope).href;
const PERIODIC_SYNC_TAG = 'central-agentic-ops-dashboard-data';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DATA_FILES = new Set(['payload-hashes.json', 'inventory-sources.json']);
const DEBUG_PREFIX = 'cao';
const RUN_SHARD_PATH = /\/gh-aw-logs-runs\/[^/]+\.jsonl$/i;
const RECORD_SHARD_PATH = /\/gh-aw-logs-records\/[^/]+\.jsonl$/i;
const APP_ASSETS = [];

/**
 * Extracts the raw `debug` query parameter from a location search string
 * without depending on `URLSearchParams`. The dashboard registers this worker
 * with a stable script URL, because a script URL that varies with the page's
 * `?debug=` value is a service worker update that activates a replacement
 * worker and reloads every controlled page. The page forwards its `debug`
 * value on each `DOWNLOAD_DATA` message instead; `self.location.search` is
 * only a fallback for registrations that still carry the parameter.
 * @param {string} search
 */
function debugParameterValue(search) {
  const match = /(?:^|[?&])debug=([^&]*)/.exec(search || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/** @param {string} pattern */
function debugPatternExpression(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`, 'i');
}

/**
 * @param {string} category
 * @param {string} [value]
 */
function isDebugEnabled(category, value = debugParameterValue(self.location?.search ?? '')) {
  if (!value) return false;
  const patterns = value.split(/[\s,]+/).filter(Boolean);
  const included = patterns
    .filter((pattern) => !pattern.startsWith('-'))
    .map((pattern) => debugPatternExpression(pattern === '1' || pattern.toLowerCase() === 'true' ? '*' : pattern));
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('-'))
    .map((pattern) => debugPatternExpression(pattern.slice(1)));
  if (excluded.some((pattern) => pattern.test(category))) return false;
  return included.some((pattern) => pattern.test(category));
}

/**
 * Category-scoped debug logger mirroring `dashboard/site/src/debug.js`. The
 * service worker cannot `import` that ES module while it runs as a classic
 * script, so this is a minimal, dependency-free port of the same behavior.
 * `test/unit/service-worker.test.js` cross-checks pattern-matching parity
 * with `debug.js` so the two stay in sync.
 * @param {string | undefined} debug Page-supplied `debug` value, if any.
 * @param {string} category
 * @param {unknown[]} values
 */
function debugLog(debug, category, ...values) {
  if (typeof console === 'undefined' || !isDebugEnabled(category, debug || undefined)) return;
  console.debug(`[${DEBUG_PREFIX}:${category}]`, ...values);
}

function isDashboardDataUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && (DATA_FILES.has(url.pathname.split('/').at(-1))
        || RUN_SHARD_PATH.test(url.pathname)
        || RECORD_SHARD_PATH.test(url.pathname));
  } catch {
    return false;
  }
}

function isAppAssetUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && url.href.startsWith(self.registration.scope)
      && !url.pathname.startsWith('/api/')
      && !isDashboardDataUrl(url.href)
      && !url.pathname.endsWith('/service-worker.js')
      && !url.pathname.endsWith('/.dashboard-data-update-config');
  } catch {
    return false;
  }
}

function isOnlineUrl(value) {
  try {
    return new URL(value).searchParams.get('online') === '1';
  } catch {
    return false;
  }
}

function lowDataConnection() {
  const connection = self.navigator?.connection;
  return connection?.saveData || connection?.metered || connection?.type === 'cellular'
    || ['slow-2g', '2g'].includes(connection?.effectiveType);
}

async function onlineRequest(event) {
  if (isOnlineUrl(event.request.url)) return true;
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  return isOnlineUrl(client?.url);
}

async function downloadData(urls, debug, online = false) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/payload-hashes.json'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  debugLog(debug, 'data:ingestion:sw', 'downloading dashboard data', { urls: requested });
  const cache = await caches.open(DATA_CACHE);
  const hashesUrl = requested.find((url) => new URL(url).pathname.endsWith('/payload-hashes.json'));
  let hashesResponse;
  let previousHashes = null;
  let currentHashes = null;
  if (hashesUrl) {
    const previous = await cache.match(hashesUrl);
    const response = await fetch(hashesUrl, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (response.ok) {
      [previousHashes, currentHashes] = await Promise.all([
        previous?.json().catch(() => null) ?? null,
        response.clone().json().catch(() => null)
      ]);
      hashesResponse = response;
    } else if (response.status !== 404) {
      throw new Error(`Dashboard data download returned ${response.status}.`);
    }
  }
  if (!hashesUrl || !currentHashes || typeof currentHashes !== 'object') {
    if (hashesUrl) await cache.delete(hashesUrl);
    throw new Error('Dashboard activity shard manifest is unavailable.');
  }
  const responses = await Promise.all(requested
    .filter((url) => url !== hashesUrl)
    .map(async (url) => {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    const optionalInventory = new URL(url).pathname.endsWith('/inventory-sources.json');
    if (!response.ok && response.status !== 304 && !(optionalInventory && response.status === 404)) {
      throw new Error(`Dashboard data download returned ${response.status}.`);
    }
    return { url, response, optionalInventory };
  }));
  await Promise.all(responses.map(({ url, response, optionalInventory }) => (
    optionalInventory && response.status === 404
      ? cache.delete(url)
      : response.status === 304
        ? undefined
        : cache.put(url, response.clone())
  )));
  const runEntries = Object.entries(currentHashes)
    .filter(([name, hash]) => /^gh-aw-logs-runs\/[^/]+\.jsonl$/i.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .sort(([left], [right]) => left.localeCompare(right));
  const eventEntries = Object.entries(currentHashes)
    .filter(([name, hash]) => /^gh-aw-logs-records\/[^/]+\.jsonl$/i.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .sort(([left], [right]) => left.localeCompare(right));
  const phasedEntries = runEntries.length > 0 ? [...runEntries, ...eventEntries] : [];
  const shardEntries = phasedEntries;
  if (shardEntries.length === 0) {
    throw new Error('Dashboard activity shard manifest contains no compacted run-information shards.');
  }
  debugLog(debug, 'data:ingestion:sw', 'published activity manifest', { shardCount: shardEntries.length });
  const currentShardUrls = new Set();
  for (const [index, [name, hash]] of shardEntries.entries()) {
    const url = new URL(`./${name}`, hashesUrl).href;
    currentShardUrls.add(url);
    if (!online && previousHashes?.[name]?.toLowerCase?.() === hash.toLowerCase()) {
      debugLog(debug, 'data:ingestion:sw', 'skipping current shard', { name, index: index + 1, shardCount: shardEntries.length });
      continue;
    }
    debugLog(debug, 'data:ingestion:sw', 'downloading shard', { name, index: index + 1, shardCount: shardEntries.length });
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Dashboard data download returned ${response.status}.`);
    await cache.put(url, response);
    debugLog(debug, 'data:ingestion:sw', 'cached shard', { name, index: index + 1, shardCount: shardEntries.length });
  }
  for (const request of await cache.keys()) {
    if ((RUN_SHARD_PATH.test(new URL(request.url).pathname)
          || RECORD_SHARD_PATH.test(new URL(request.url).pathname))
        && !currentShardUrls.has(request.url)) {
      await cache.delete(request);
    }
  }
  if (hashesUrl && hashesResponse) await cache.put(hashesUrl, hashesResponse.clone());
  debugLog(debug, 'data:ingestion:sw', 'dashboard data download complete');
}

async function storeDataUrls(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/payload-hashes.json'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  const cache = await caches.open(CONFIG_CACHE);
  const previous = await readDataConfig(cache);
  const config = { urls: requested, lastSuccess: previous?.lastSuccess ?? 0 };
  await cache.put(CONFIG_URL, new Response(JSON.stringify(config), {
    headers: { 'content-type': 'application/json' }
  }));
  return config;
}

async function cacheAppAssets(urls) {
  const cache = await caches.open(APP_CACHE);
  await Promise.allSettled([...new Set(urls)].filter(isAppAssetUrl).map(async (url) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (response.ok) await cache.put(url, response);
  }));
}

async function cachedAppResponse(request) {
  const cache = await caches.open(APP_CACHE);
  const url = new URL(request.url);
  url.searchParams.delete('online');
  url.searchParams.delete('sha');
  url.searchParams.delete('debug');
  url.searchParams.delete('debug-shard-limit');
  url.searchParams.delete('debug-eager-ingest');
  const cached = await cache.match(url.href) ?? await cache.match(request);
  if (cached) return cached;
  if (request.mode === 'navigate') return cache.match(new URL('./', self.registration.scope).href);
  return undefined;
}

async function readDataConfig(cache) {
  const response = await cache.match(CONFIG_URL);
  if (!response) return null;
  const value = await response.json();
  if (Array.isArray(value)) return { urls: value, lastSuccess: 0 };
  if (!value || typeof value !== 'object' || !Array.isArray(value.urls)) return null;
  const lastSuccess = Number(value.lastSuccess ?? 0);
  return {
    urls: value.urls,
    lastSuccess: Number.isFinite(lastSuccess) && lastSuccess > 0 ? lastSuccess : 0
  };
}

async function downloadConfiguredData(force = false, fallbackUrls = [], debug = undefined, online = false) {
  if (lowDataConnection()) return;
  // Periodic Background Sync itself is deferred by the browser when power conditions are unsuitable.
  const cache = await caches.open(CONFIG_CACHE);
  const previous = await readDataConfig(cache);
  const fallback = [...new Set(fallbackUrls)].filter(isDashboardDataUrl);
  const config = fallback.length > 0
    ? { urls: fallback, lastSuccess: previous?.lastSuccess ?? 0 }
    : previous;
  if (!config) return 0;
  if (!force && config.lastSuccess > 0 && Date.now() - config.lastSuccess < UPDATE_INTERVAL_MS) {
    return config.lastSuccess;
  }
  await downloadData(config.urls, debug, online);
  config.lastSuccess = Date.now();
  await cache.put(CONFIG_URL, new Response(JSON.stringify(config), {
    headers: { 'content-type': 'application/json' }
  }));
  return config.lastSuccess;
}

self.addEventListener('install', (event) => {
  // Updated workers wait until the page canaries them before activation.
  if (APP_ASSETS.length) event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    for (let index = 0; index < APP_ASSETS.length; index += 2) {
      await Promise.all(APP_ASSETS.slice(index, index + 2).map(async (path) => {
        const url = new URL(path, self.registration.scope).href;
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to cache dashboard application.');
        await cache.put(url, response);
      }));
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => (
        key.startsWith('central-agentic-ops-dashboard-data-') && key !== DATA_CACHE
      ) || (
        key.startsWith('central-agentic-ops-dashboard-app-') && key !== APP_CACHE
      ))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'APP_UPDATE_DOWNLOADED', version: VERSION });
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!isDashboardDataUrl(event.request.url)) {
    if (!isAppAssetUrl(event.request.url)) return;
    event.respondWith((async () => {
      const online = await onlineRequest(event);
      if (!online && lowDataConnection()) {
        const cached = await cachedAppResponse(event.request);
        if (cached) return cached;
      }
      try {
        const response = await fetch(online
          ? new Request(event.request, { cache: 'no-store' })
          : event.request);
        if (response.ok) {
          const cache = await caches.open(APP_CACHE);
          await cache.put(event.request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch (error) {
        if (online) throw error;
        const cached = await cachedAppResponse(event.request);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }
  if (event.request.cache === 'no-store') {
    event.respondWith((async () => {
      if (!await onlineRequest(event) && lowDataConnection() && DATA_FILES.has(new URL(event.request.url).pathname.split('/').at(-1))) {
        const cache = await caches.open(DATA_CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
      }
      return fetch(event.request);
    })());
    return;
  }
  const responseRequest = onlineRequest(event).then((online) => {
    const request = online ? new Request(event.request, { cache: 'no-store' }) : event.request;
    return { online, request };
  });
  const networkResponse = responseRequest.then(({ request, online }) => {
    if (!online && lowDataConnection()) return caches.open(DATA_CACHE).then((cache) => cache.match(request))
      .then((cached) => cached ?? fetch(request));
    return fetch(request);
  });
  event.waitUntil(networkResponse.then(async (response) => {
    if (!response.ok) return;
    const copy = response.clone();
    const cache = await caches.open(DATA_CACHE);
    await cache.put(event.request, copy);
  }).catch(() => undefined));
  event.respondWith(networkResponse.catch(async (error) => {
      if ((await responseRequest).online) throw error;
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw error;
  }));
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(downloadConfiguredData());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CANARY') {
    event.ports[0]?.postMessage({ type: 'CANARY_OK', version: VERSION });
    return;
  }
  if (event.data?.type === 'ACTIVATE') {
    void self.skipWaiting();
    return;
  }
  if (event.data?.type === 'CACHE_APP_ASSETS' && Array.isArray(event.data.urls)) {
    event.waitUntil(cacheAppAssets(event.data.urls));
    return;
  }
  if (event.data?.type === 'CLEAR_BACKGROUND_DATA') {
    const task = caches.delete(CONFIG_CACHE).then(
      () => event.ports[0]?.postMessage({ type: 'BACKGROUND_DATA_CLEARED', version: VERSION })
    );
    event.waitUntil(task);
    return;
  }
  if (event.data?.type === 'CONFIGURE_BACKGROUND_DATA' && Array.isArray(event.data.urls)) {
    const assets = Array.isArray(event.data.assets) ? event.data.assets : [];
    const configure = storeDataUrls(event.data.urls).then(
      (config) => event.ports[0]?.postMessage({
        type: 'BACKGROUND_DATA_CONFIGURED',
        version: VERSION,
        lastSuccess: config.lastSuccess
      }),
      (error) => event.ports[0]?.postMessage({
        type: 'BACKGROUND_DATA_CONFIGURATION_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
    );
    event.waitUntil(Promise.allSettled([configure, cacheAppAssets(assets)]));
    return;
  }
  if (event.data?.type !== 'DOWNLOAD_DATA' || !Array.isArray(event.data.urls)) return;
  const debug = typeof event.data.debug === 'string' ? event.data.debug : undefined;
  const task = downloadConfiguredData(true, event.data.urls, debug, isOnlineUrl(event.source?.url)).then(
    (lastSuccess) => event.ports[0]?.postMessage({
      type: 'DOWNLOAD_COMPLETE',
      version: VERSION,
      lastSuccess
    }),
    (error) => event.ports[0]?.postMessage({
      type: 'DOWNLOAD_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
  );
  event.waitUntil(task);
});
