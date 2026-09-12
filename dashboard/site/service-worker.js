const VERSION = '1';
const DATA_CACHE = `central-agentic-ops-dashboard-data-${VERSION}`;
const CONFIG_CACHE = 'central-agentic-ops-dashboard-config';
const CONFIG_URL = new URL('./.dashboard-data-update-config', self.registration.scope).href;
const PERIODIC_SYNC_TAG = 'central-agentic-ops-dashboard-data';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DATA_FILES = new Set(['gh-aw-logs.jsonl', 'inventory-sources.json']);

function isDashboardDataUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && DATA_FILES.has(url.pathname.split('/').at(-1));
  } catch {
    return false;
  }
}

async function downloadData(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/gh-aw-logs.jsonl'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  const responses = await Promise.all(requested.map(async (url) => {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    const optionalInventory = new URL(url).pathname.endsWith('/inventory-sources.json');
    if (!response.ok && !(optionalInventory && response.status === 404)) {
      throw new Error(`Dashboard data download returned ${response.status}.`);
    }
    return { url, response, optionalInventory };
  }));
  const cache = await caches.open(DATA_CACHE);
  await Promise.all(responses.map(({ url, response, optionalInventory }) => (
    optionalInventory && response.status === 404
      ? cache.delete(url)
      : cache.put(url, response.clone())
  )));
}

async function storeDataUrls(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/gh-aw-logs.jsonl'))) {
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
      .filter((key) => key.startsWith('central-agentic-ops-dashboard-data-') && key !== DATA_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !isDashboardDataUrl(event.request.url)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(DATA_CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
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
  if (event.data?.type === 'CONFIGURE_BACKGROUND_DATA' && Array.isArray(event.data.urls)) {
    const task = storeDataUrls(event.data.urls).then(
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
    event.waitUntil(task);
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
