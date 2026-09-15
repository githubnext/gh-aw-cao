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

/**
 * Extracts the raw `debug` query parameter from a location search string
 * without depending on `URLSearchParams`, which the service worker's
 * `self.location.search` reflects from its own (registered) script URL. The
 * dashboard forwards the page's `?debug=` value onto that script URL so this
 * context can see the same debug configuration as the page and data worker.
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

/** @param {string} category */
function isDebugEnabled(category) {
  const value = debugParameterValue(self.location?.search ?? '');
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
 * @param {string} category
 * @param {unknown[]} values
 */
function debugLog(category, ...values) {
  if (typeof console === 'undefined' || !isDebugEnabled(category)) return;
  console.debug(`[${DEBUG_PREFIX}:${category}]`, ...values);
}

function isDashboardDataUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && (DATA_FILES.has(url.pathname.split('/').at(-1))
        || /\/gh-aw-logs-shards\/[A-Za-z0-9._-]+\.jsonl$/.test(url.pathname));
  } catch {
    return false;
  }
}

function isAppAssetUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && url.href.startsWith(self.registration.scope)
      && !isDashboardDataUrl(url.href)
      && !url.pathname.endsWith('/service-worker.js')
      && !url.pathname.endsWith('/.dashboard-data-update-config');
  } catch {
    return false;
  }
}

async function downloadData(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/payload-hashes.json'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  debugLog('data:ingestion:sw', 'downloading dashboard data', { urls: requested });
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
  const shardEntries = Object.entries(currentHashes)
    .filter(([name, hash]) => /^gh-aw-logs-shards\/[A-Za-z0-9._-]+\.jsonl$/.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .sort(([left], [right]) => left.localeCompare(right));
  if (shardEntries.length === 0) throw new Error('Dashboard activity shard manifest is empty.');
  debugLog('data:ingestion:sw', 'published activity manifest', { shardCount: shardEntries.length });
  const currentShardUrls = new Set();
  for (const [index, [name, hash]] of shardEntries.entries()) {
    const url = new URL(`./${name}`, hashesUrl).href;
    currentShardUrls.add(url);
    if (previousHashes?.[name]?.toLowerCase?.() === hash.toLowerCase()) {
      debugLog('data:ingestion:sw', 'skipping current shard', { name, index: index + 1, shardCount: shardEntries.length });
      continue;
    }
    debugLog('data:ingestion:sw', 'downloading shard', { name, index: index + 1, shardCount: shardEntries.length });
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Dashboard data download returned ${response.status}.`);
    await cache.put(url, response);
    debugLog('data:ingestion:sw', 'cached shard', { name, index: index + 1, shardCount: shardEntries.length });
  }
  for (const request of await cache.keys()) {
    if (/\/gh-aw-logs-shards\/[A-Za-z0-9._-]+\.jsonl$/.test(new URL(request.url).pathname)
        && !currentShardUrls.has(request.url)) {
      await cache.delete(request);
    }
  }
  if (hashesUrl && hashesResponse) await cache.put(hashesUrl, hashesResponse.clone());
  debugLog('data:ingestion:sw', 'dashboard data download complete');
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

async function downloadConfiguredData(force = false, fallbackUrls = []) {
  const connection = self.navigator?.connection;
  if (connection?.saveData || connection?.metered || connection?.type === 'cellular') return;
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
  await downloadData(config.urls);
  config.lastSuccess = Date.now();
  await cache.put(CONFIG_URL, new Response(JSON.stringify(config), {
    headers: { 'content-type': 'application/json' }
  }));
  return config.lastSuccess;
}

self.addEventListener('install', () => {
  // Updated workers wait until the page canaries them before activation.
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
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!isDashboardDataUrl(event.request.url)) {
    if (!isAppAssetUrl(event.request.url)) return;
    event.respondWith((async () => {
      if (event.request.cache === 'no-store') return fetch(event.request);
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(APP_CACHE);
          await cache.put(event.request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch (error) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match(new URL('./', self.registration.scope).href);
          if (fallback) return fallback;
        }
        throw error;
      }
    })());
    return;
  }
  if (event.request.cache === 'no-store') {
    event.respondWith(fetch(event.request));
    return;
  }
  const networkResponse = fetch(event.request);
  event.waitUntil(networkResponse.then(async (response) => {
    if (!response.ok) return;
    const copy = response.clone();
    const cache = await caches.open(DATA_CACHE);
    await cache.put(event.request, copy);
  }).catch(() => undefined));
  event.respondWith(networkResponse.catch(async (error) => {
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
  const task = downloadConfiguredData(true, event.data.urls).then(
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
